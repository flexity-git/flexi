import { describe, expect, it, vi } from "vitest";
import { createDbAuditWriter, redactArgs, redactText } from "./audit.js";

const silentLog = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
};

describe("redactArgs", () => {
  it("redacts sensitive keys at any depth", () => {
    const out = redactArgs({
      store: "sk",
      confirm_token: "abc.def",
      nested: { authorization: "Bearer flexi_x", apiKey: "k", password: "p", ok: 1 },
      list: [{ secret: "s" }],
    });
    expect(out).toEqual({
      store: "sk",
      confirm_token: "[redacted]",
      nested: { authorization: "[redacted]", apiKey: "[redacted]", password: "[redacted]", ok: 1 },
      list: [{ secret: "[redacted]" }],
    });
  });

  it("masks e-mail addresses in values, e.g. query params", () => {
    expect(redactArgs({ params: ["jane@shop.example", 5] })).toEqual({ params: ["[email]", 5] });
    expect(redactArgs("where email = 'jane.example@shop.example'")).toBe("where email = '[email]'");
  });

  it("truncates long strings and survives deep or odd values", () => {
    const long = redactArgs("x".repeat(2000)) as string;
    expect(long.length).toBeLessThan(600);
    expect(long).toMatch(/more\]$/);
    let deep: any = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(() => redactArgs(deep)).not.toThrow();
    expect(redactArgs(undefined)).toBeNull();
  });
});

describe("createDbAuditWriter", () => {
  it("inserts redacted args, sql and counters, never the confirm token", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const write = createDbAuditWriter({ query }, silentLog());
    await write({
      tokenId: 4,
      tool: "shoptet_product_visibility_set",
      args: { store: "sk", guid: "g-1", visibility: "hidden", confirm_token: "payload.signature" },
      durationMs: 12.6,
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/insert into mcp_audit_log/);
    expect(params[0]).toBe(4);
    expect(params[1]).toBe("shoptet_product_visibility_set");
    expect(JSON.parse(params[2] as string)).toEqual({ store: "sk", guid: "g-1", visibility: "hidden", confirm_token: "[redacted]" });
    expect(JSON.stringify(params)).not.toContain("payload.signature");
    expect(params[7]).toBe(13);
  });

  it("does not throw when the insert fails, but logs without args", async () => {
    const log = silentLog();
    const write = createDbAuditWriter({ query: vi.fn(async () => Promise.reject(new Error("relation missing"))) }, log);
    await expect(write({ tokenId: null, tool: "query", args: { sql: "select 1" }, sql: "select 1", durationMs: 1 })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("mcp audit insert failed", { tool: "query", reason: "relation missing" });
  });
});

describe("redaction of audited sql and error text", () => {
  it("masks e-mails, API tokens, bearer values and long hex in sql and error columns", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const write = createDbAuditWriter({ query }, silentLog());
    const hash = "a".repeat(64);
    await write({
      tokenId: null,
      tool: "query",
      args: {},
      sql: "select 1 from store_products where note = 'jane@shop.example'",
      error: `[ref 0a1b2c3d] invalid input syntax for type integer: "${hash}" Bearer flexi_${"x".repeat(43)}`,
      durationMs: 1,
    });
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params[3]).toBe("select 1 from store_products where note = '[email]'");
    expect(params[6]).toBe('[ref 0a1b2c3d] invalid input syntax for type integer: "[hex]" Bearer [redacted]');
    expect(redactText(`token flexi_${"y".repeat(43)}`)).toBe("token [token]");
  });
});
