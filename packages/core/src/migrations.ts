import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";
import { log as defaultLog } from "./logger.js";

/** The subset of pg we use, so tests can pass a fake. */
export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}
export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface MigrationSource {
  /** `core` or a module name. */
  module: string;
  /** Directory holding `NNNN_description.sql` files. */
  dir: string | URL;
}

export interface RunMigrationsOptions {
  pool: MigrationPool;
  /** Applied in this order. Put core first. */
  sources: MigrationSource[];
  log?: Logger;
}

export interface MigrationResult {
  applied: { module: string; filename: string }[];
  alreadyApplied: number;
}

/** Directory of the core SQL migrations shipped with this package. */
export const coreMigrationsDir: URL = new URL("../migrations/", import.meta.url);

/** Arbitrary but fixed key for pg_advisory_lock, so two runners never overlap. */
export const MIGRATION_LOCK_KEY = 4_172_830_551;

const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * The bookkeeping table is created here rather than in a SQL file: the runner
 * needs it before it can record any file, including 0001_core.sql.
 */
const BOOTSTRAP_SQL = `
create table if not exists flexi_migrations (
  module text not null,
  filename text not null,
  sha256 text not null,
  applied_at timestamptz not null default now(),
  primary key (module, filename)
)`;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function dirPath(dir: string | URL): string {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}

async function listMigrationFiles(source: MigrationSource): Promise<string[]> {
  const path = dirPath(source.dir);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Migrations directory for "${source.module}" does not exist: ${path}`);
    }
    throw err;
  }
  const sqlFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name);
  const misnamed = sqlFiles.filter((name) => !FILE_PATTERN.test(name));
  if (misnamed.length > 0) {
    // A misnamed file would otherwise be skipped silently and never applied.
    throw new Error(
      `Migrations for "${source.module}" have invalid file names: ${misnamed.join(", ")}. ` +
        "Expected NNNN_description.sql (lowercase, digits, underscores).",
    );
  }
  return sqlFiles.sort();
}

/**
 * Applies pending SQL migrations. Each file runs in its own transaction and is
 * recorded in flexi_migrations with its sha256. A file that was applied and has
 * since changed is an error, never a silent re-run.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const log = options.log ?? defaultLog;
  const modules = new Set<string>();
  for (const source of options.sources) {
    if (modules.has(source.module)) throw new Error(`Migration source "${source.module}" is listed twice.`);
    modules.add(source.module);
  }

  // Read and validate every file before touching the database.
  const plan: { module: string; filename: string; sql: string; hash: string }[] = [];
  for (const source of options.sources) {
    for (const filename of await listMigrationFiles(source)) {
      const sql = await readFile(join(dirPath(source.dir), filename), "utf8");
      plan.push({ module: source.module, filename, sql, hash: sha256(sql) });
    }
  }

  const client = await options.pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: 0 };
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    locked = true;
    await client.query(BOOTSTRAP_SQL);

    const { rows } = await client.query("select module, filename, sha256 from flexi_migrations");
    const applied = new Map<string, string>();
    for (const row of rows) applied.set(`${row.module}/${row.filename}`, row.sha256);

    for (const item of plan) {
      const known = applied.get(`${item.module}/${item.filename}`);
      if (known !== undefined) {
        if (known !== item.hash) {
          throw new Error(
            `Migration ${item.module}/${item.filename} was already applied but its content changed ` +
              `(recorded sha256 ${known.slice(0, 12)}, file sha256 ${item.hash.slice(0, 12)}). ` +
              "Applied migrations must not be edited; add a new file instead.",
          );
        }
        result.alreadyApplied += 1;
        continue;
      }

      await client.query("begin");
      try {
        await client.query(item.sql);
        await client.query("insert into flexi_migrations (module, filename, sha256) values ($1, $2, $3)", [
          item.module,
          item.filename,
          item.hash,
        ]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${item.module}/${item.filename} failed: ${message}`, { cause: err });
      }
      log.info("migration applied", { module: item.module, filename: item.filename });
      result.applied.push({ module: item.module, filename: item.filename });
    }

    const onDisk = new Set(plan.map((p) => `${p.module}/${p.filename}`));
    for (const key of applied.keys()) {
      const [module] = key.split("/");
      if (module !== undefined && modules.has(module) && !onDisk.has(key)) {
        log.warn("applied migration is missing on disk", { migration: key });
      }
    }
    return result;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
