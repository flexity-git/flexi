import {
  ConfigError,
  coreMigrationsDir,
  createNotifier,
  getPool,
  loadConfig,
  runMigrations,
  SLACK_CHANNELS,
  slackWebhookVar,
  type Env,
  type FlexiConfig,
  type Logger,
  type MigrationSource,
} from "@flexity/core";
import pg from "pg";
import type { ParsedArgs } from "./args.js";
import { parseTarget } from "./args.js";
import { buildTaskContext, createShoptetFactory, loadShoptetPackage, runTask, type ShoptetLoad } from "./context.js";
import { discoverModules, type DiscoveredModule } from "./discovery.js";

export interface CliDeps {
  env: Env;
  /** Command output (stdout). Logs go to `log` (stderr). */
  out: (line: string) => void;
  log: Logger;
  discover?: (enabled: string[] | null) => Promise<DiscoveredModule[]>;
  loadShoptet?: () => Promise<ShoptetLoad>;
  /** Connects to the database; `error` is null when reachable, `migrations` is null before the first migrate. */
  checkDatabase?: (databaseUrl: string) => Promise<{ error: string | null; migrations: number | null }>;
  /** Migrations of @flexity/mcp when it is installed, else null. */
  loadMcpMigrations?: () => Promise<URL | string | null>;
}

// Loaded by a variable specifier: @flexity/mcp depends on this package, so a static
// import would be a cycle, and the MCP server is optional.
async function loadMcpMigrationsDefault(): Promise<URL | string | null> {
  const specifier = "@flexity/mcp";
  try {
    const mod = (await import(specifier)) as { mcpMigrationsDir?: URL | string };
    return mod.mcpMigrationsDir ?? null;
  } catch {
    return null;
  }
}

const discoverDefault = (enabled: string[] | null) => discoverModules({ enabled });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function defaultCheckDatabase(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("select 1");
    const { rows } = await client.query("select to_regclass('flexi_migrations') is not null as present");
    if (!rows[0]?.present) return { error: null, migrations: null };
    const count = await client.query("select count(*)::int as n from flexi_migrations");
    return { error: null, migrations: Number(count.rows[0]?.n ?? 0) };
  } catch (err) {
    return { error: errorText(err), migrations: null };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function doctor(deps: CliDeps): Promise<number> {
  const { out } = deps;
  let failed = false;
  let config: FlexiConfig | null = null;
  try {
    config = loadConfig(deps.env);
    out("config: ok");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    failed = true;
    out("config: INVALID");
    for (const issue of err.issues) out(`  - ${issue}`);
  }

  if (config) {
    out(`stores: ${config.stores.map((s) => (s.key === config!.primaryStore ? `${s.key} (primary)` : s.key)).join(", ")}`);
    out(`timezone: ${config.timezone}`);
    if (!config.databaseUrl) {
      out("database: not configured (FLEXI_DATABASE_URL unset; live-only mode)");
    } else {
      const result = await (deps.checkDatabase ?? defaultCheckDatabase)(config.databaseUrl);
      if (result.error) {
        failed = true;
        out(`database: UNREACHABLE (${result.error})`);
      } else {
        out(
          `database: reachable, ${
            result.migrations === null ? "not migrated yet (run `flexi migrate`)" : `${result.migrations} migrations applied`
          }`,
        );
      }
    }
    for (const channel of SLACK_CHANNELS) {
      out(`slack ${channel}: ${config.slack[channel] ? "configured" : `not configured (${slackWebhookVar(channel)}), logs only`}`);
    }
  }

  try {
    const modules = await (deps.discover ?? discoverDefault)(config?.modules ?? null);
    out(`modules: ${modules.length === 0 ? "(none installed)" : modules.map((m) => m.module.name).join(", ")}`);
  } catch (err) {
    failed = true;
    out(`modules: ERROR (${errorText(err)})`);
  }

  out(failed ? "doctor: problems found" : "doctor: all good");
  return failed ? 1 : 0;
}

export async function list(deps: CliDeps): Promise<number> {
  let enabled: string[] | null = null;
  try {
    enabled = loadConfig(deps.env).modules;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    deps.log.warn("configuration is invalid; listing all installed modules. Run `flexi doctor` for details.");
  }
  const modules = await (deps.discover ?? discoverDefault)(enabled);
  if (modules.length === 0) {
    deps.out("No modules installed. Add a workspace package named @flexity/module-<name>.");
    return 0;
  }
  for (const { module } of modules) {
    deps.out(`${module.name}  ${module.description}`);
    for (const [name, task] of Object.entries(module.tasks)) deps.out(`  ${module.name}:${name}  ${task.description}`);
  }
  return 0;
}

export async function migrate(deps: CliDeps): Promise<number> {
  const config = loadConfig(deps.env);
  if (!config.databaseUrl) throw new Error("FLEXI_DATABASE_URL is not configured; nothing to migrate.");
  const modules = await (deps.discover ?? discoverDefault)(config.modules);
  const sources: MigrationSource[] = [{ module: "core", dir: coreMigrationsDir }];
  const mcpDir = await (deps.loadMcpMigrations ?? loadMcpMigrationsDefault)();
  if (mcpDir) sources.push({ module: "mcp", dir: mcpDir });
  for (const { module } of modules) {
    if (module.migrationsDir !== undefined) sources.push({ module: module.name, dir: module.migrationsDir });
  }
  const result = await runMigrations({ pool: getPool(config), sources, log: deps.log });
  deps.out(`migrations: ${result.applied.length} applied, ${result.alreadyApplied} already applied`);
  for (const a of result.applied) deps.out(`  + ${a.module}/${a.filename}`);
  return 0;
}

export async function run(deps: CliDeps, args: ParsedArgs): Promise<number> {
  const target = parseTarget(args.positionals[0]);
  if (args.positionals.length > 1) throw new Error(`Unexpected argument "${args.positionals[1]}". Pass task options as --key=value.`);
  const config = loadConfig(deps.env);
  const modules = await (deps.discover ?? discoverDefault)(config.modules);
  const found = modules.find((m) => m.module.name === target.module);
  if (!found) {
    const names = modules.map((m) => m.module.name).join(", ") || "(none)";
    throw new Error(`Module "${target.module}" is not installed or not enabled. Available: ${names}.`);
  }
  if (!found.module.tasks[target.task]) {
    throw new Error(
      `Module "${target.module}" has no task "${target.task}". Tasks: ${Object.keys(found.module.tasks).join(", ") || "(none)"}.`,
    );
  }

  const log = deps.log.child({ module: target.module, task: target.task });
  const db = config.databaseUrl ? getPool(config) : null;
  const shoptetLoad = await (deps.loadShoptet ?? loadShoptetPackage)();
  const ctx = buildTaskContext({
    config,
    db,
    notifier: createNotifier(config, { log }),
    log,
    args: args.options,
    shoptet: createShoptetFactory(config, shoptetLoad),
  });
  const outcome = await runTask({ module: found.module, taskName: target.task, ctx, db, log });
  if (outcome.ok) {
    deps.out(JSON.stringify({ ok: true, module: target.module, task: target.task, summary: outcome.summary ?? null }));
    return 0;
  }
  deps.out(JSON.stringify({ ok: false, module: target.module, task: target.task, error: outcome.error }));
  return 1;
}
