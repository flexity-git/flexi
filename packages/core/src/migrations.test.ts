import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { coreMigrationsDir, MIGRATION_LOCK_KEY, runMigrations, sha256 } from "./migrations.js";
import type { MigrationClient, MigrationPool } from "./migrations.js";

/** In-memory stand-in for pg: records statements and keeps flexi_migrations rows. */
function fakePool(initial: { module: string; filename: string; sha256: string }[] = []) {
  const rows = [...initial];
  const statements: string[] = [];
  let released = 0;
  let pending: (typeof rows)[number] | null = null;
  const client: MigrationClient = {
    async query(text, params) {
      statements.push(text.trim().split("\n")[0]!.trim());
      if (text.includes("FAIL")) throw new Error("syntax error at FAIL");
      if (text.startsWith("select module, filename, sha256")) return { rows: [...rows] };
      if (text.startsWith("insert into flexi_migrations")) {
        const [module, filename, hash] = params as string[];
        pending = { module: module!, filename: filename!, sha256: hash! };
      }
      if (text === "commit" && pending) {
        rows.push(pending);
        pending = null;
      }
      if (text === "rollback") pending = null;
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  const pool: MigrationPool = { connect: async () => client };
  return { pool, rows, statements, released: () => released };
}

async function makeDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "flexi-mig-"));
  await mkdir(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

const quiet = createLogger({}, { write: () => {} });

describe("runMigrations", () => {
  it("applies pending files in order, each in a transaction, under an advisory lock", async () => {
    const dir = await makeDir({ "0002_b.sql": "create table b ();", "0001_a.sql": "create table a ();" });
    const db = fakePool();
    const result = await runMigrations({ pool: db.pool, sources: [{ module: "demo", dir }], log: quiet });

    expect(result.applied).toEqual([
      { module: "demo", filename: "0001_a.sql" },
      { module: "demo", filename: "0002_b.sql" },
    ]);
    expect(db.statements).toEqual([
      "select pg_advisory_lock($1)",
      "create table if not exists flexi_migrations (",
      "select module, filename, sha256 from flexi_migrations",
      "begin",
      "create table a ();",
      "insert into flexi_migrations (module, filename, sha256) values ($1, $2, $3)",
      "commit",
      "begin",
      "create table b ();",
      "insert into flexi_migrations (module, filename, sha256) values ($1, $2, $3)",
      "commit",
      "select pg_advisory_unlock($1)",
    ]);
    expect(db.rows[0]).toEqual({ module: "demo", filename: "0001_a.sql", sha256: sha256("create table a ();") });
    expect(db.released()).toBe(1);
    expect(MIGRATION_LOCK_KEY).toBeTypeOf("number");
  });

  it("skips already applied files with a matching hash", async () => {
    const dir = await makeDir({ "0001_a.sql": "select 1;" });
    const db = fakePool([{ module: "demo", filename: "0001_a.sql", sha256: sha256("select 1;") }]);
    const result = await runMigrations({ pool: db.pool, sources: [{ module: "demo", dir }], log: quiet });
    expect(result).toEqual({ applied: [], alreadyApplied: 1 });
    expect(db.statements).not.toContain("begin");
  });

  it("refuses to continue when an applied file changed", async () => {
    const dir = await makeDir({ "0001_a.sql": "select 2;" });
    const db = fakePool([{ module: "demo", filename: "0001_a.sql", sha256: sha256("select 1;") }]);
    await expect(runMigrations({ pool: db.pool, sources: [{ module: "demo", dir }], log: quiet })).rejects.toThrow(
      /demo\/0001_a.sql was already applied but its content changed/,
    );
    expect(db.statements.at(-1)).toBe("select pg_advisory_unlock($1)");
    expect(db.released()).toBe(1);
  });

  it("rolls back a failing file and does not record it", async () => {
    const dir = await makeDir({ "0001_ok.sql": "select 1;", "0002_bad.sql": "FAIL;", "0003_later.sql": "select 3;" });
    const db = fakePool();
    await expect(runMigrations({ pool: db.pool, sources: [{ module: "demo", dir }], log: quiet })).rejects.toThrow(
      /Migration demo\/0002_bad.sql failed: syntax error/,
    );
    expect(db.rows.map((r) => r.filename)).toEqual(["0001_ok.sql"]);
    expect(db.statements).toContain("rollback");
    expect(db.statements).not.toContain("select 3;");
  });

  it("keeps modules apart and applies sources in the given order", async () => {
    const core = await makeDir({ "0001_core.sql": "select 'core';" });
    const mod = await makeDir({ "0001_core.sql": "select 'mod';" });
    const db = fakePool();
    const result = await runMigrations({
      pool: db.pool,
      sources: [
        { module: "core", dir: core },
        { module: "demo", dir: mod },
      ],
      log: quiet,
    });
    expect(result.applied.map((a) => a.module)).toEqual(["core", "demo"]);
  });

  it("rejects misnamed files, missing directories and duplicate sources before touching the DB", async () => {
    const db = fakePool();
    const misnamed = await makeDir({ "init.sql": "select 1;" });
    await expect(runMigrations({ pool: db.pool, sources: [{ module: "demo", dir: misnamed }], log: quiet })).rejects.toThrow(
      /invalid file names: init.sql/,
    );
    await expect(
      runMigrations({ pool: db.pool, sources: [{ module: "demo", dir: join(misnamed, "nope") }], log: quiet }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      runMigrations({
        pool: db.pool,
        sources: [
          { module: "demo", dir: misnamed },
          { module: "demo", dir: misnamed },
        ],
        log: quiet,
      }),
    ).rejects.toThrow(/listed twice/);
    expect(db.statements).toEqual([]);
  });

  it("ships a valid core migration", async () => {
    const db = fakePool();
    const result = await runMigrations({ pool: db.pool, sources: [{ module: "core", dir: coreMigrationsDir }], log: quiet });
    expect(result.applied).toEqual([{ module: "core", filename: "0001_core.sql" }]);
  });
});
