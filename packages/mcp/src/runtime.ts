import { discoverModules } from "@flexity/cli";
import { getPool, loadConfig, closePool as closeCorePools, type Env, type FlexiConfig, type FlexiModule, type Logger } from "@flexity/core";
import { createShoptetClient, type ShoptetClient } from "@flexity/shoptet";
import pg from "pg";
import { createDbAuditWriter, createLogAuditWriter } from "./audit.js";
import { buildCatalog, type CatalogTable } from "./catalog.js";
import { createConfirmTokens } from "./confirm.js";
import { assertRoleName, type QueryRoles } from "./query.js";
import { DEFAULT_STDIO_SCOPES, parseScopesStrict } from "./scopes.js";
import type { Caller, ServerDeps } from "./tools.js";

export interface RuntimeOptions {
  env: Env;
  log: Logger;
  /** Overridable for tests. */
  discover?: (enabled: string[] | null) => Promise<Array<{ module: FlexiModule<any> }>>;
  fetch?: typeof fetch;
  /** "http" refuses to run SQL tools without the dedicated reader login. */
  mode?: "stdio" | "http";
}

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

/**
 * A pool used only for the query tools, never for audit or tokens. Its own
 * small connection budget, and a session-level timeout as a second guard.
 */
function createQueryPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 3, statement_timeout: 20_000 });
  pool.on("error", () => {});
  queryPools.push(pool);
  return pool;
}
const queryPools: pg.Pool[] = [];

/** Ends the query pools and the shared core pools. */
export async function closeAllPools(): Promise<void> {
  const all = queryPools.splice(0);
  await Promise.all(all.map((p) => p.end()));
  await closeCorePools();
}

function readUrl(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!POSTGRES_URL.test(value)) throw new Error(`${name} must start with postgres:// or postgresql://.`);
  return value;
}

function clientFactory(config: FlexiConfig, log: Logger, fetchImpl?: typeof fetch): (key: string) => ShoptetClient {
  const clients = new Map<string, ShoptetClient>();
  return (key) => {
    const store = config.stores.find((s) => s.key === key);
    if (!store) throw new Error(`Unknown store "${key}".`);
    let client = clients.get(key);
    if (!client) {
      client = createShoptetClient({
        token: store.token,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onEvent: (event) => log.info("shoptet event", { store: key, ...event }),
      });
      clients.set(key, client);
    }
    return client;
  };
}

export async function loadCatalog(
  config: FlexiConfig,
  options: Pick<RuntimeOptions, "discover" | "log">,
): Promise<{ catalog: Map<string, CatalogTable>; warnings: string[] }> {
  const discover = options.discover ?? ((enabled: string[] | null) => discoverModules({ enabled }));
  try {
    const modules = await discover(config.modules);
    return { catalog: buildCatalog(modules.map((m) => m.module)), warnings: [] };
  } catch (err) {
    // A broken module must not take down the live Shoptet tools; the SQL tools
    // just see an empty catalogue and data_catalog reports why.
    const message = err instanceof Error ? err.message : String(err);
    options.log.error("mcp: module discovery failed, SQL catalogue is empty", { reason: message });
    return { catalog: new Map(), warnings: [`Module discovery failed: ${message}`] };
  }
}

function queryRoles(env: Env): QueryRoles | undefined {
  const base = env.FLEXI_MCP_QUERY_ROLE?.trim();
  const customers = env.FLEXI_MCP_CUSTOMERS_ROLE?.trim();
  if (!base && !customers) return undefined;
  return {
    ...(base ? { base: assertRoleName(base, "FLEXI_MCP_QUERY_ROLE") } : {}),
    ...(customers ? { customers: assertRoleName(customers, "FLEXI_MCP_CUSTOMERS_ROLE") } : {}),
  };
}

/** Builds everything the tools need from environment variables. */
export async function buildDeps(options: RuntimeOptions): Promise<ServerDeps> {
  const { env, log } = options;
  const config = loadConfig(env);
  const db = config.databaseUrl ? getPool(config) : null;
  const readerUrl = readUrl(env, "FLEXI_MCP_DATABASE_URL");
  const customersUrl = readUrl(env, "FLEXI_MCP_CUSTOMERS_DATABASE_URL");
  if ((readerUrl || customersUrl) && !db) {
    throw new Error("FLEXI_MCP_DATABASE_URL is set but FLEXI_DATABASE_URL is not; the audit log needs FLEXI_DATABASE_URL.");
  }
  if (customersUrl && !readerUrl) {
    throw new Error("FLEXI_MCP_CUSTOMERS_DATABASE_URL needs FLEXI_MCP_DATABASE_URL as well.");
  }
  if (db && options.mode === "http" && !readerUrl) {
    throw new Error(
      "HTTP mode with SQL tools needs FLEXI_MCP_DATABASE_URL: a dedicated login that can only SELECT the allowlisted tables. " +
        "Run `flexi-mcp db-roles` for the SQL, or unset FLEXI_DATABASE_URL to serve live Shoptet tools only.",
    );
  }
  if (db && !readerUrl) {
    log.warn(
      "mcp: FLEXI_MCP_DATABASE_URL is not set; SQL tools connect as the main flexi user. Fine for a single local user, not for shared access.",
    );
  }
  const queryUrl = readerUrl ?? config.databaseUrl;
  const queryPool = db && queryUrl ? createQueryPool(queryUrl) : null;
  const customersQueryPool = customersUrl ? createQueryPool(customersUrl) : null;

  const { catalog, warnings } = db ? await loadCatalog(config, options) : { catalog: new Map(), warnings: [] };
  const roles = queryRoles(env);
  const writesEnabled = env.FLEXI_MCP_ENABLE_WRITES?.trim().toLowerCase() === "true";
  const secret = env.FLEXI_MCP_CONFIRM_SECRET?.trim();
  if (secret && secret.length < 32) throw new Error("FLEXI_MCP_CONFIRM_SECRET must be at least 32 characters.");

  return {
    config,
    clients: clientFactory(config, log, options.fetch),
    db,
    queryPool,
    customersQueryPool,
    catalog,
    catalogWarnings: warnings,
    ...(roles ? { queryRoles: roles } : {}),
    confirm: createConfirmTokens(secret ? { secret } : {}),
    writesEnabled,
    audit: db ? createDbAuditWriter(db, log) : createLogAuditWriter(log),
    now: () => new Date(),
  };
}

/** The stdio caller: scopes from FLEXI_MCP_SCOPES, default data:read,shoptet:read. */
export function stdioCaller(env: Env): Caller {
  const raw = env.FLEXI_MCP_SCOPES?.trim();
  const scopes = raw ? parseScopesStrict(raw, "FLEXI_MCP_SCOPES") : [...DEFAULT_STDIO_SCOPES];
  return { tokenId: null, id: "stdio", scopes };
}
