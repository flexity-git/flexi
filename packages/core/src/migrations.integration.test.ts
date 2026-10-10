import pg from "pg";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { coreMigrationsDir, runMigrations } from "./migrations.js";

const url = process.env.FLEXI_DATABASE_URL_TEST;

// Runs only against a throwaway database named in FLEXI_DATABASE_URL_TEST, inside a temporary schema.
describe.skipIf(!url)("runMigrations against Postgres", () => {
  it("applies core migrations once and is idempotent", async () => {
    const schema = `flexi_test_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const log = createLogger({}, { write: () => {} });
    try {
      const first = await runMigrations({ pool, sources: [{ module: "core", dir: coreMigrationsDir }], log });
      expect(first.applied.length).toBeGreaterThan(0);
      const second = await runMigrations({ pool, sources: [{ module: "core", dir: coreMigrationsDir }], log });
      expect(second.applied).toEqual([]);
      const { rows } = await pool.query("select count(*)::int as n from flexi_task_runs");
      expect(rows[0].n).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
});
