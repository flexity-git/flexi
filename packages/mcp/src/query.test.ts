import { describe, expect, it } from "vitest";
import { MAX_BYTES, roleFor, runReadOnlyQuery } from "./query.js";
import { generateRoleSql } from "./roles.js";
import { callTool, visibleTools } from "./server.js";
import { caller, catalog, fakePool, makeDeps, parseResult } from "./test-helpers.js";

describe("runReadOnlyQuery", () => {
  it("runs inside a read-only transaction with a timeout, extended protocol, and always rolls back", async () => {
    const { pool, client, statements } = fakePool([{ guid: "p-1" }]);
    const out = await runReadOnlyQuery(pool, {
      sql: "select guid from store_products where guid = $1",
      params: ["p-1"],
      scopes: ["data:read"],
      catalog,
    });
    expect(out).toEqual({ rows: [{ guid: "p-1" }], rowCount: 1, truncated: false, tables: ["store_products"] });
    expect(statements.map((s) => s.text.split("\n")[0])).toEqual([
      "BEGIN",
      "SET TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = 15000",
      "SET LOCAL idle_in_transaction_session_timeout = 20000",
      "SELECT * FROM (",
      "ROLLBACK",
    ]);
    const main = statements[4]!;
    expect(main).toMatchObject({ values: ["p-1"], queryMode: "extended" });
    expect(main.text).toMatch(/guid = \$1\n\) AS flexi_q LIMIT 501$/);
    expect(client.release).toHaveBeenCalled();
  });

  it("flags truncation by row limit", async () => {
    const { pool } = fakePool([{ a: 1 }, { a: 2 }, { a: 3 }]);
    const out = await runReadOnlyQuery(pool, { sql: "select 1 from store_products", maxRows: 2, scopes: ["data:read"], catalog });
    expect(out).toMatchObject({ rowCount: 2, truncated: true });
  });

  it("flags truncation by byte cap", async () => {
    const big = "x".repeat(Math.ceil(MAX_BYTES / 4));
    const { pool } = fakePool(Array.from({ length: 8 }, () => ({ big })));
    const out = await runReadOnlyQuery(pool, { sql: "select 1 from store_products", scopes: ["data:read"], catalog });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.rows).length).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("never touches the database when the guard rejects", async () => {
    const { pool } = fakePool();
    await expect(runReadOnlyQuery(pool, { sql: "select * from order_customers", scopes: ["data:read"], catalog })).rejects.toThrow(
      /needs scope data:read:customers/,
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects non-scalar params", async () => {
    const { pool } = fakePool();
    await expect(
      runReadOnlyQuery(pool, { sql: "select 1 from store_products", params: [{ a: 1 }], scopes: ["data:read"], catalog }),
    ).rejects.toThrow(/params may only contain/);
  });

  it("switches to the configured role per caller scope", async () => {
    const roles = { base: "flexi_mcp_ro", customers: "flexi_mcp_ro_customers" };
    expect(roleFor(["data:read"], roles)).toBe("flexi_mcp_ro");
    expect(roleFor(["data:read", "data:read:customers"], roles)).toBe("flexi_mcp_ro_customers");
    expect(roleFor(["data:read:customers"], roles)).toBe("flexi_mcp_ro");
    expect(roleFor(["data:read"], undefined)).toBeNull();

    const { pool, statements } = fakePool([]);
    await runReadOnlyQuery(pool, { sql: "select 1 from store_products", scopes: ["data:read"], catalog, roles });
    expect(statements.map((s) => s.text)).toContain("SET LOCAL ROLE flexi_mcp_ro");
  });
});

describe("SQL tools through callTool", () => {
  it("lists SQL tools only with a database, runs a query and audits sql, row count and truncation", async () => {
    const { pool } = fakePool([{ guid: "p-1" }]);
    const { deps, audits } = makeDeps({ db: pool, queryPool: pool });
    expect(visibleTools(deps, caller(["data:read"])).map((t) => t.name)).toEqual(["data_catalog", "schema_describe", "query"]);

    const res = parseResult(await callTool(deps, caller(["data:read"]), "query", { sql: "select guid from store_products", params: [] }));
    expect(res.rows).toEqual([{ guid: "p-1" }]);
    expect(audits[0]).toMatchObject({ tool: "query", sql: "select guid from store_products", rowCount: 1, truncated: false, error: null });
  });

  it("audits rejected queries with the error", async () => {
    const { pool } = fakePool();
    const { deps, audits } = makeDeps({ db: pool, queryPool: pool });
    const res = await callTool(deps, caller(["data:read"]), "query", { sql: "select * from mcp_audit_log" });
    expect(res.isError).toBe(true);
    expect(audits[0]).toMatchObject({ tool: "query", sql: "select * from mcp_audit_log", error: expect.stringMatching(/not available/) });
  });

  it("data_catalog shows every table with accessibility and the caller's scopes", async () => {
    const { pool } = fakePool();
    const { deps } = makeDeps({ db: pool, queryPool: pool });
    const res = parseResult(await callTool(deps, caller(["data:read"]), "data_catalog", {}));
    expect(res.callerScopes).toEqual(["data:read"]);
    expect(res.tables).toEqual([
      { name: "order_customers", scope: "data:read:customers", description: "Customer contacts", module: "mirror", accessible: false },
      { name: "store_products", scope: "data:read", description: "Product mirror", module: "mirror", accessible: true },
    ]);
  });

  it("schema_describe returns only tables the caller can read", async () => {
    const { pool, statements } = fakePool();
    const { deps } = makeDeps({ db: pool, queryPool: pool });
    const res = parseResult(await callTool(deps, caller(["data:read"]), "schema_describe", {}));
    expect(res.tables.map((t: { table: string }) => t.table)).toEqual(["store_products"]);
    expect(statements.at(-1)!.values).toEqual([["store_products"]]);
  });
});

describe("generateRoleSql", () => {
  it("creates dedicated read-only logins and grants personal-data tables only to the customers reader", () => {
    const sql = generateRoleSql(catalog);
    expect(sql).toContain("CREATE ROLE flexi_mcp_reader LOGIN NOSUPERUSER");
    expect(sql).toContain("ALTER ROLE flexi_mcp_reader SET default_transaction_read_only = on;");
    expect(sql).toContain("ALTER ROLE flexi_mcp_reader SET statement_timeout = '15s';");
    expect(sql).toContain("ALTER ROLE flexi_mcp_reader SET temp_file_limit = '256MB';");
    expect(sql).toContain("ALTER ROLE flexi_mcp_reader SET work_mem = '16MB';");
    expect(sql).toContain("GRANT SELECT ON store_products TO flexi_mcp_reader, flexi_mcp_reader_customers;");
    expect(sql).toContain("GRANT SELECT ON order_customers TO flexi_mcp_reader_customers;");
    expect(sql).not.toMatch(/order_customers TO flexi_mcp_reader[,;]/);
    // Never a member of another role, never a password in the file.
    expect(sql).not.toMatch(/GRANT \w+(, \w+)* TO (CURRENT_USER|flexi_mcp_reader)/);
    expect(sql).not.toMatch(/PASSWORD '/);
    expect(() => generateRoleSql(catalog, { reader: "bad; drop" })).toThrow(/plain lowercase role name/);
  });
});

describe("pool selection", () => {
  it("uses the customers pool only for callers holding data:read:customers", async () => {
    const reader = fakePool([{ n: 1 }]);
    const customers = fakePool([{ n: 2 }]);
    const { deps } = makeDeps({ db: reader.pool, queryPool: reader.pool, customersQueryPool: customers.pool });
    await callTool(deps, caller(["data:read"]), "query", { sql: "select 1 from store_products" });
    expect(reader.pool.connect).toHaveBeenCalledTimes(1);
    expect(customers.pool.connect).not.toHaveBeenCalled();
    await callTool(deps, caller(["data:read", "data:read:customers"]), "query", { sql: "select 1 from order_customers" });
    expect(customers.pool.connect).toHaveBeenCalledTimes(1);
  });
});

describe("database errors never reach the caller", () => {
  it("returns a generic message with a reference and keeps the redacted detail in the audit entry", async () => {
    const { pool, client } = fakePool();
    client.query.mockImplementation(async (q: unknown) => {
      const text = typeof q === "string" ? q : (q as { text: string }).text;
      if (text.includes("flexi_q")) throw new Error("invalid input syntax for type integer: \"jane@shop.example\"");
      return { rows: [] };
    });
    const { deps, audits } = makeDeps({ db: pool, queryPool: pool });
    const res = await callTool(deps, caller(["data:read"]), "query", { sql: "select guid::int from store_products" });
    expect(res.isError).toBe(true);
    const shown = res.content[0]!.text;
    expect(shown).not.toContain("jane@shop.example");
    expect(shown).not.toContain("invalid input syntax");
    const ref = /Reference ([0-9a-f]{8})/.exec(shown)?.[1];
    expect(ref).toBeDefined();
    expect(audits[0]!.error).toContain(`[ref ${ref}]`);
  });

  it("still returns guard rejections verbatim", async () => {
    const { pool } = fakePool();
    const { deps } = makeDeps({ db: pool, queryPool: pool });
    const res = await callTool(deps, caller(["data:read"]), "query", { sql: "select pg_sleep(1)" });
    expect(res.content[0]!.text).toMatch(/pg_sleep\(\) is not on the allowlist/);
  });
});
