import { ToolError } from "./errors.js";
import type { CatalogTable } from "./catalog.js";
import type { PoolLike } from "./db-types.js";
import { hasScope } from "./scopes.js";
import { validateSelect } from "./sql-guard.js";

export const DEFAULT_MAX_ROWS = 500;
export const HARD_MAX_ROWS = 5000;
export const MAX_BYTES = 1_000_000;
export const STATEMENT_TIMEOUT_MS = 15_000;
export const MAX_PARAMS = 100;

export interface QueryInput {
  sql: string;
  params?: unknown[];
  maxRows?: number;
  scopes: readonly string[];
  catalog: ReadonlyMap<string, CatalogTable>;
  roles?: QueryRoles;
}

/**
 * Optional extra: roles switched to with SET LOCAL ROLE inside the read-only
 * transaction. This is NOT the security boundary (the session user is still
 * the connecting user); the boundary is connecting as a dedicated reader login
 * (FLEXI_MCP_DATABASE_URL, see `flexi-mcp db-roles`).
 */
export interface QueryRoles {
  base?: string;
  customers?: string;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertRoleName(name: string, source: string): string {
  if (!ROLE_NAME.test(name)) throw new ToolError(`${source} must be a plain lowercase role name, got "${name}".`);
  return name;
}

/** Picks the role for a caller: the customers role only for callers holding data:read:customers. */
export function roleFor(scopes: readonly string[], roles: QueryRoles | undefined): string | null {
  if (!roles) return null;
  if (hasScope(scopes, "data:read:customers") && roles.customers) return roles.customers;
  return roles.base ?? null;
}

export interface QueryOutput {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when rows were cut by the row limit or the byte cap. Never draw totals from a truncated result. */
  truncated: boolean;
  tables: string[];
}

function checkParams(params: unknown[]): unknown[] {
  if (params.length > MAX_PARAMS) throw new ToolError(`At most ${MAX_PARAMS} params are allowed.`);
  for (const p of params) {
    if (p !== null && !["string", "number", "boolean"].includes(typeof p)) {
      throw new ToolError("params may only contain strings, numbers, booleans and null.");
    }
  }
  return params;
}

/**
 * Validates and runs one SELECT.
 *
 * - guard first (single read-only statement, allowlisted tables, scopes);
 * - BEGIN + SET TRANSACTION READ ONLY + statement_timeout, always rolled back;
 * - the extended protocol is forced, so the server itself refuses a second
 *   statement even if the guard ever let one through;
 * - the query is wrapped as a subquery with LIMIT n+1 to detect truncation.
 */
export async function runReadOnlyQuery(pool: PoolLike, input: QueryInput): Promise<QueryOutput> {
  const { tables } = validateSelect(input.sql, input.scopes, input.catalog);
  const params = checkParams(input.params ?? []);
  const maxRows = Math.min(Math.max(1, Math.floor(input.maxRows ?? DEFAULT_MAX_ROWS)), HARD_MAX_ROWS);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${STATEMENT_TIMEOUT_MS + 5000}`);
    const role = roleFor(input.scopes, input.roles);
    // Role names are validated identifiers (assertRoleName), never caller input.
    if (role) await client.query(`SET LOCAL ROLE ${assertRoleName(role, "query role")}`);

    // The closing parenthesis is on its own line: a trailing `-- comment` in
    // the user's SQL would otherwise swallow it.
    const res = await client.query({
      text: `SELECT * FROM (\n${input.sql.trim().replace(/;\s*$/, "")}\n) AS flexi_q LIMIT ${maxRows + 1}`,
      values: params,
      queryMode: "extended",
    });

    let rows = res.rows as Record<string, unknown>[];
    let truncated = rows.length > maxRows;
    if (truncated) rows = rows.slice(0, maxRows);

    while (rows.length > 1 && JSON.stringify(rows).length > MAX_BYTES) {
      rows = rows.slice(0, Math.floor(rows.length / 2));
      truncated = true;
    }
    // A single oversized row is returned with the flag rather than dropped:
    // zero rows would read as "nothing found".
    if (rows.length === 1 && JSON.stringify(rows).length > MAX_BYTES) truncated = true;

    return { rows, rowCount: rows.length, truncated, tables };
  } finally {
    // Nothing to commit, ever.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
