import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./db-types.js";
import { parseScopesStrict } from "./scopes.js";

/**
 * API tokens for the HTTP transport.
 *
 * Only the sha256 of a token is stored. The plain value is shown once at
 * creation. Tokens are 256 random bits, so a slow password hash is not needed:
 * the hash protects against reading the database, not against guessing.
 */

export const TOKEN_PREFIX = "flexi_";

export interface ResolvedToken {
  id: number;
  name: string;
  scopes: string[];
}

export interface TokenRow extends ResolvedToken {
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/** Cheap pre-check so a foreign bearer value never reaches the database. */
export function looksLikeToken(token: string): boolean {
  return /^flexi_[A-Za-z0-9_-]{40,}$/.test(token.trim());
}

export async function createToken(
  db: Queryable,
  input: { name: string; scopes: readonly string[] | string },
): Promise<{ token: string; row: TokenRow }> {
  const name = input.name.trim();
  if (!name) throw new Error("Token name is required (--name).");
  if (name.length > 200) throw new Error("Token name is too long (max 200 characters).");
  const scopes = parseScopesStrict(input.scopes, "--scopes");
  const token = generateToken();
  const res = await db.query(
    `insert into flexi_api_tokens (name, token_sha256, scopes)
     values ($1, $2, $3::text[])
     returning id, name, scopes, created_at, last_used_at, revoked_at`,
    [name, hashToken(token), scopes],
  );
  return { token, row: toRow(res.rows[0]) };
}

/** Returns the active token for a bearer value, or null for unknown and revoked tokens alike. */
export async function resolveToken(db: Queryable, token: string): Promise<ResolvedToken | null> {
  const value = token.trim();
  if (!looksLikeToken(value)) return null;
  const res = await db.query(
    `select id, name, scopes from flexi_api_tokens where token_sha256 = $1 and revoked_at is null`,
    [hashToken(value)],
  );
  const row = res.rows[0];
  if (!row) return null;
  // Best effort: a failed timestamp update must not block the request.
  await db.query(`update flexi_api_tokens set last_used_at = now() where id = $1`, [row.id]).catch(() => undefined);
  return { id: Number(row.id), name: String(row.name), scopes: (row.scopes as string[] | null) ?? [] };
}

export async function listTokens(db: Queryable): Promise<TokenRow[]> {
  const res = await db.query(
    `select id, name, scopes, created_at, last_used_at, revoked_at from flexi_api_tokens order by id`,
  );
  return res.rows.map(toRow);
}

/** Soft revoke: the row stays so the audit log can still be traced to it. */
export async function revokeToken(db: Queryable, id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Token id must be a positive integer.");
  const res = await db.query(`update flexi_api_tokens set revoked_at = now() where id = $1 and revoked_at is null`, [
    id,
  ]);
  return (res.rowCount ?? 0) > 0;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRow(r: any): TokenRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    scopes: r.scopes ?? [],
    createdAt: iso(r.created_at) ?? "",
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  };
}
