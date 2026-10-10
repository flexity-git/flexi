import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closePool, createLogger, getPool, loadConfig, type Env, type Logger } from "@flexity/core";
import type { Queryable } from "./db-types.js";
import { startHttpServer } from "./http.js";
import { generateRoleSql } from "./roles.js";
import { buildDeps, closeAllPools, loadCatalog, stdioCaller } from "./runtime.js";
import { createMcpServer } from "./server.js";
import { createToken, listTokens, revokeToken } from "./tokens.js";

export const USAGE = `flexi-mcp: MCP server for Shoptet stores

Usage:
  flexi-mcp                         Start on stdio (Claude Code, Claude Desktop)
  flexi-mcp --http [--port=8787] [--host=127.0.0.1]
                                    Start Streamable HTTP on /mcp (bearer token required)
  flexi-mcp token create --name=<name> --scopes=data:read,shoptet:read
                                    Create an API token (printed once)
  flexi-mcp token list              List tokens (never shows token values)
  flexi-mcp token revoke <id>       Revoke a token
  flexi-mcp db-roles [--reader=<role>] [--customers=<role>]
                                    Print SQL for the dedicated read-only logins

Scopes: data:read, data:read:customers (needs data:read), shoptet:read,
shoptet:write:products. "*" grants all read scopes, never write scopes.

Environment: FLEXI_STORES, SHOPTET_TOKEN_<KEY>, FLEXI_DATABASE_URL (optional),
FLEXI_MCP_SCOPES (stdio, default data:read,shoptet:read), FLEXI_MCP_ENABLE_WRITES,
FLEXI_MCP_DATABASE_URL (required for --http with SQL), FLEXI_MCP_CUSTOMERS_DATABASE_URL,
FLEXI_MCP_ALLOWED_HOSTS, FLEXI_MCP_QUERY_ROLE, FLEXI_MCP_CUSTOMERS_ROLE, FLEXI_MCP_CONFIRM_SECRET.`;

export interface CliArgs {
  positionals: string[];
  options: Record<string, string | true>;
}

const VALUE_OPTIONS = new Set(["name", "scopes", "port", "host", "reader", "customers"]);

/** Parses `--key=value`, `--key value` (for known value options) and bare flags. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Invalid option "${arg}".`);
    if (eq !== -1) options[key] = body.slice(eq + 1);
    else if (VALUE_OPTIONS.has(key)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Option --${key} needs a value.`);
      options[key] = next;
      i++;
    } else options[key] = true;
  }
  return { positionals, options };
}

export interface CliDeps {
  env: Env;
  out: (line: string) => void;
  log: Logger;
  /** Database for token commands. Defaults to the FLEXI_DATABASE_URL pool. */
  db?: Queryable;
}

function tokenDb(deps: CliDeps): Queryable {
  if (deps.db) return deps.db;
  const url = deps.env.FLEXI_DATABASE_URL?.trim();
  if (!url) throw new Error("FLEXI_DATABASE_URL is not set. Tokens live in the database; run `flexi migrate` first.");
  return getPool({ databaseUrl: url });
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function tokenCommand(deps: CliDeps, args: CliArgs): Promise<number> {
  const [, sub, ...rest] = args.positionals;
  const db = tokenDb(deps);
  if (sub === "create") {
    const name = str(args.options.name);
    const scopes = str(args.options.scopes);
    if (!name || !scopes) throw new Error("Usage: flexi-mcp token create --name=<name> --scopes=data:read,shoptet:read");
    const { token, row } = await createToken(db, { name, scopes });
    deps.out(`Created token #${row.id} "${row.name}" with scopes ${row.scopes.join(",")}.`);
    deps.out("Copy it now, it is not stored and will not be shown again:");
    deps.out(token);
    return 0;
  }
  if (sub === "list") {
    const rows = await listTokens(db);
    if (rows.length === 0) deps.out("No tokens.");
    for (const r of rows) {
      const state = r.revokedAt ? `revoked ${r.revokedAt}` : "active";
      deps.out(`#${r.id}  ${r.name}  [${r.scopes.join(",")}]  ${state}  created ${r.createdAt}  last used ${r.lastUsedAt ?? "never"}`);
    }
    return 0;
  }
  if (sub === "revoke") {
    const id = Number(rest[0]);
    if (!rest[0] || !Number.isSafeInteger(id)) throw new Error("Usage: flexi-mcp token revoke <id>");
    const done = await revokeToken(db, id);
    deps.out(done ? `Revoked token #${id}.` : `Token #${id} not found or already revoked.`);
    return done ? 0 : 1;
  }
  throw new Error("Usage: flexi-mcp token create|list|revoke");
}

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  const log = createLogger({ component: "flexi-mcp" });
  const out = (line: string) => void process.stdout.write(line + "\n");
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.options.help) {
    out(USAGE);
    return 0;
  }

  const command = args.positionals[0];
  try {
    if (command === "token") {
      try {
        return await tokenCommand({ env, out, log }, args);
      } finally {
        await closePool();
      }
    }
    if (command === "db-roles") {
      const config = loadConfig(env);
      const { catalog } = await loadCatalog(config, { log });
      const reader = str(args.options.reader);
      const customers = str(args.options.customers);
      out(generateRoleSql(catalog, { ...(reader ? { reader } : {}), ...(customers ? { customers } : {}) }));
      return 0;
    }
    if (command !== undefined) throw new Error(`Unknown command "${command}".\n\n${USAGE}`);

    const deps = await buildDeps({ env, log, mode: args.options.http ? "http" : "stdio" });
    if (args.options.http) {
      const port = Number(str(args.options.port) ?? "8787");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535.");
      const host = str(args.options.host) ?? "127.0.0.1";
      const allowedHosts = (env.FLEXI_MCP_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const http = await startHttpServer(deps, { port, host, log, ...(allowedHosts.length > 0 ? { allowedHosts } : {}) });
      return await new Promise<number>((resolve) => http.once("close", () => resolve(0)));
    }

    const caller = stdioCaller(env);
    const server = createMcpServer(deps, caller);
    await server.connect(new StdioServerTransport());
    log.info("flexi-mcp ready on stdio", {
      stores: deps.config.stores.map((s) => s.key),
      scopes: caller.scopes,
      sql: deps.queryPool !== null,
      tables: deps.catalog.size,
      writes: deps.writesEnabled,
    });
    const code = await new Promise<number>((resolve) => {
      server.onclose = () => resolve(0);
      // The client closing stdin ends the session.
      process.stdin.once("end", () => void server.close().finally(() => resolve(0)));
    });
    await closeAllPools();
    return code;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
