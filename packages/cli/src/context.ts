import {
  getStore,
  type FlexiConfig,
  type FlexiModule,
  type Logger,
  type Notifier,
  type TaskArgs,
  type TaskContext,
  type TaskSummary,
} from "@flexity/core";
import type pg from "pg";

/** The part of the @flexity/shoptet contract the CLI relies on. */
export interface ShoptetClientOptions {
  token: string;
  baseUrl?: string;
  maxConcurrency?: number;
  fetch?: typeof fetch;
}
export interface ShoptetPackage {
  createShoptetClient(options: ShoptetClientOptions): object;
}

export type ShoptetLoad = { ok: true; pkg: ShoptetPackage } | { ok: false; reason: string };

/**
 * Imports @flexity/shoptet at runtime. The specifier is a variable so the CLI
 * typechecks even when that package is absent. A failure is kept and only
 * surfaces when a task actually asks for a client.
 */
export async function loadShoptetPackage(): Promise<ShoptetLoad> {
  const specifier = "@flexity/shoptet";
  try {
    const mod = (await import(specifier)) as Partial<ShoptetPackage>;
    if (typeof mod.createShoptetClient !== "function") {
      return { ok: false, reason: `${specifier} does not export createShoptetClient` };
    }
    return { ok: true, pkg: mod as ShoptetPackage };
  } catch (err) {
    return { ok: false, reason: `${specifier} could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One client per store key, created on first use. */
export function createShoptetFactory(config: FlexiConfig, load: ShoptetLoad): (storeKey: string) => object {
  const clients = new Map<string, object>();
  return (storeKey) => {
    const store = getStore(config, storeKey);
    if (!load.ok) throw new Error(load.reason);
    let client = clients.get(store.key);
    if (!client) {
      client = load.pkg.createShoptetClient({ token: store.token });
      clients.set(store.key, client);
    }
    return client;
  };
}

export interface BuildContextOptions {
  config: FlexiConfig;
  db: pg.Pool | null;
  notifier: Notifier;
  log: Logger;
  args: TaskArgs;
  shoptet: (storeKey: string) => object;
  now?: () => Date;
}

export function buildTaskContext(options: BuildContextOptions): TaskContext<object> {
  return {
    config: options.config,
    db: options.db,
    shoptet: options.shoptet,
    notify: (channel, text, opts) => options.notifier.notify(channel, text, opts),
    log: options.log,
    now: options.now ?? (() => new Date()),
    args: options.args,
  };
}

/** The part of pg used to record task runs. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TaskOutcome {
  ok: boolean;
  summary?: TaskSummary;
  error?: string;
}

const UNDEFINED_TABLE = "42P01";

/**
 * Runs one task and records it in flexi_task_runs when a database is available.
 * A missing flexi_task_runs table (migrations not run) is a warning, not a
 * reason to skip the task itself.
 */
export async function runTask(options: {
  module: FlexiModule<any>;
  taskName: string;
  ctx: TaskContext<any>;
  db: Queryable | null;
  log: Logger;
}): Promise<TaskOutcome> {
  const { module, taskName, ctx, db, log } = options;
  const task = module.tasks[taskName];
  if (!task) throw new Error(`Module "${module.name}" has no task "${taskName}".`);

  let runId: string | null = null;
  if (db) {
    try {
      const { rows } = await db.query(
        "insert into flexi_task_runs (module, task, status) values ($1, $2, 'running') returning id",
        [module.name, taskName],
      );
      runId = String(rows[0]?.id ?? "") || null;
    } catch (err) {
      if ((err as { code?: string }).code === UNDEFINED_TABLE) {
        log.warn("flexi_task_runs does not exist; run `flexi migrate`. Continuing without run log.");
      } else {
        throw err;
      }
    }
  }

  const finish = async (status: "ok" | "failed", error: string | null, summary: TaskSummary | null) => {
    if (!db || runId === null) return;
    try {
      await db.query(
        "update flexi_task_runs set finished_at = now(), status = $2, error = $3, summary = $4::jsonb where id = $1",
        [runId, status, error, summary === null ? null : JSON.stringify(summary)],
      );
    } catch (err) {
      log.error("could not record task result", { runId, err: err instanceof Error ? err.message : String(err) });
    }
  };

  const started = Date.now();
  try {
    const summary = (await task.run(ctx)) ?? undefined;
    await finish("ok", null, summary ?? null);
    log.info("task finished", { durationMs: Date.now() - started });
    return summary === undefined ? { ok: true } : { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish("failed", message.slice(0, 4000), null);
    log.error("task failed", { durationMs: Date.now() - started, err });
    return { ok: false, error: message };
  }
}
