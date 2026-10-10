import type pg from "pg";
import type { FlexiConfig, SlackChannel } from "./config.js";
import type { Logger } from "./logger.js";
import type { NotifyOptions, NotifyResult } from "./notifier.js";

/**
 * Opaque Shoptet client handle. Modules that use the client pass the real type
 * from @flexity/shoptet as the type parameter: `defineModule<ShoptetClient>({...})`.
 */
export type ShoptetClientLike = object;

export type TaskArgs = Record<string, string | boolean>;

export interface TaskContext<TShoptet = ShoptetClientLike> {
  config: FlexiConfig;
  /** Shared pg Pool, or null when FLEXI_DATABASE_URL is not set. */
  db: pg.Pool | null;
  /** Client for a configured store key. Throws for unknown keys. */
  shoptet(storeKey: string): TShoptet;
  notify(channel: SlackChannel, text: string, opts?: NotifyOptions): Promise<NotifyResult>;
  log: Logger;
  now(): Date;
  /** Parsed `--key=value` options; a bare `--flag` is `true`. */
  args: TaskArgs;
}

/** Returned summary is stored in flexi_task_runs.summary (must be JSON-serializable). */
export type TaskSummary = Record<string, unknown>;

export interface TaskDefinition<TShoptet = ShoptetClientLike> {
  description: string;
  run(ctx: TaskContext<TShoptet>): Promise<TaskSummary | void>;
}

export interface TableExposure {
  name: string;
  /** Scope a caller needs to query this table through MCP SQL, e.g. `data:read`. */
  scope: string;
  description: string;
}

export interface FlexiModule<TShoptet = ShoptetClientLike> {
  /** kebab-case, unique; the package is named @flexity/module-<name>. */
  name: string;
  description: string;
  migrationsDir?: URL | string;
  tasks: Record<string, TaskDefinition<TShoptet>>;
  tables?: TableExposure[];
}

const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TASK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Validates and returns a module manifest. Throws on an invalid shape. */
export function defineModule<TShoptet = ShoptetClientLike>(module: FlexiModule<TShoptet>): FlexiModule<TShoptet> {
  assertModule(module);
  return module;
}

/** Runtime check used by defineModule and by CLI discovery for untyped imports. */
export function assertModule(value: unknown, source = "module"): asserts value is FlexiModule<any> {
  const fail = (why: string): never => {
    throw new Error(`Invalid flexi module (${source}): ${why}`);
  };
  if (typeof value !== "object" || value === null) fail("default export is not an object");
  const m = value as Partial<FlexiModule>;
  if (typeof m.name !== "string" || !MODULE_NAME.test(m.name)) fail("name must be kebab-case");
  if (m.name === "core" || m.name === "mcp") fail(`name "${m.name}" is reserved`);
  if (typeof m.description !== "string") fail("description must be a string");
  if (typeof m.tasks !== "object" || m.tasks === null) fail("tasks must be an object");
  for (const [taskName, task] of Object.entries(m.tasks ?? {})) {
    if (!TASK_NAME.test(taskName)) fail(`task name "${taskName}" must be kebab-case`);
    if (typeof task?.run !== "function") fail(`task "${taskName}" has no run function`);
    if (typeof task?.description !== "string") fail(`task "${taskName}" has no description`);
  }
  if (m.migrationsDir !== undefined && typeof m.migrationsDir !== "string" && !(m.migrationsDir instanceof URL)) {
    fail("migrationsDir must be a URL or a path string");
  }
  for (const table of m.tables ?? []) {
    if (!TABLE_NAME.test(table?.name ?? "")) fail(`table name "${table?.name}" is not a plain SQL identifier`);
    if (typeof table.scope !== "string" || table.scope.length === 0) fail(`table "${table.name}" needs a scope`);
    if (typeof table.description !== "string") fail(`table "${table.name}" needs a description`);
  }
}
