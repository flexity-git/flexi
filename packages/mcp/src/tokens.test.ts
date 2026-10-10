import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createToken, generateToken, hashToken, listTokens, looksLikeToken, resolveToken, revokeToken } from "./tokens.js";

function fakeDb(rowsFor: (sql: string, params: unknown[]) => any[] = () => []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = rowsFor(sql, params);
      return { rows, rowCount: rows.length };
    }),
  };
  return { db, calls };
}

describe("token format and hashing", () => {
  it("generates prefixed 256-bit tokens that are unique", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^flexi_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(looksLikeToken(a)).toBe(true);
  });

  it("hashes with sha256 hex and ignores surrounding whitespace", () => {
    const t = "flexi_example";
    expect(hashToken(t)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(hashToken(` ${t}\n`)).toBe(hashToken(t));
  });

  it("rejects values that do not look like tokens", () => {
    expect(looksLikeToken("Bearer x")).toBe(false);
    expect(looksLikeToken("flexi_short")).toBe(false);
  });
});

describe("createToken", () => {
  it("stores only the hash and returns the plain token once", async () => {
    const { db, calls } = fakeDb(() => [
      { id: "7", name: "analyst", scopes: ["data:read"], created_at: new Date("2026-10-01T00:00:00Z"), last_used_at: null, revoked_at: null },
    ]);
    const { token, row } = await createToken(db, { name: " analyst ", scopes: "data:read" });
    expect(row.id).toBe(7);
    const params = calls[0]!.params;
    expect(params[0]).toBe("analyst");
    expect(params[1]).toBe(hashToken(token));
    expect(params).not.toContain(token);
    expect(JSON.stringify(calls)).not.toContain(token);
  });

  it("refuses unknown scopes and customers without data:read", async () => {
    const { db } = fakeDb();
    await expect(createToken(db, { name: "x", scopes: "data:write" })).rejects.toThrow(/unknown scope/);
    await expect(createToken(db, { name: "x", scopes: "data:read:customers" })).rejects.toThrow(/extends data:read/);
    await expect(createToken(db, { name: " ", scopes: "data:read" })).rejects.toThrow(/name is required/);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("resolveToken", () => {
  const token = generateToken();

  it("finds an active token by hash and touches last_used_at", async () => {
    const { db, calls } = fakeDb((sql, params) =>
      sql.startsWith("select") && params[0] === hashToken(token) ? [{ id: "3", name: "bot", scopes: ["shoptet:read"] }] : [],
    );
    expect(await resolveToken(db, token)).toEqual({ id: 3, name: "bot", scopes: ["shoptet:read"] });
    expect(calls[0]!.sql).toMatch(/revoked_at is null/);
    expect(calls[1]!.sql).toMatch(/last_used_at = now\(\)/);
    expect(JSON.stringify(calls)).not.toContain(token);
  });

  it("returns null for unknown or revoked tokens and skips the database for foreign values", async () => {
    const { db } = fakeDb();
    expect(await resolveToken(db, token)).toBeNull();
    const second = fakeDb();
    expect(await resolveToken(second.db, "not-a-flexi-token")).toBeNull();
    expect(second.db.query).not.toHaveBeenCalled();
  });
});

describe("list and revoke", () => {
  it("lists without token values and revokes softly", async () => {
    const { db, calls } = fakeDb((sql) =>
      sql.startsWith("select")
        ? [{ id: 1, name: "a", scopes: ["data:read"], created_at: "2026-10-01", last_used_at: null, revoked_at: null }]
        : [{}],
    );
    const rows = await listTokens(db);
    expect(rows[0]).toEqual({ id: 1, name: "a", scopes: ["data:read"], createdAt: "2026-10-01", lastUsedAt: null, revokedAt: null });
    expect(calls[0]!.sql).not.toMatch(/token_sha256/);
    expect(await revokeToken(db, 1)).toBe(true);
    expect(calls[1]!.sql).toMatch(/set revoked_at = now\(\) where id = \$1 and revoked_at is null/);
    await expect(revokeToken(db, -1)).rejects.toThrow(/positive integer/);
  });
});
