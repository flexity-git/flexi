import type { CatalogTable } from "./catalog.js";
import { assertRoleName } from "./query.js";

export const DEFAULT_READER_ROLE = "flexi_mcp_reader";
export const DEFAULT_CUSTOMERS_READER_ROLE = "flexi_mcp_reader_customers";

/**
 * SQL for the dedicated login roles the query tools connect as. This is the
 * primary boundary: Postgres itself refuses any table outside the grants, so a
 * gap in the SQL guard does not mean access to tokens, the audit log or
 * customer data.
 *
 * - `reader`: SELECT on data:read tables only (FLEXI_MCP_DATABASE_URL).
 * - `customers reader`: also the data:read:customers tables
 *   (FLEXI_MCP_CUSTOMERS_DATABASE_URL).
 *
 * Neither role is a member of any other role. Printed by `flexi-mcp db-roles`
 * for an administrator to review and run, because it needs CREATEROLE and
 * depends on which modules are installed. Idempotent.
 */
export function generateRoleSql(
  catalog: ReadonlyMap<string, CatalogTable>,
  roles: { reader?: string; customers?: string } = {},
): string {
  const reader = assertRoleName(roles.reader ?? DEFAULT_READER_ROLE, "reader role");
  const customers = assertRoleName(roles.customers ?? DEFAULT_CUSTOMERS_READER_ROLE, "customers reader role");
  if (reader === customers) throw new Error("The reader and customers reader roles must differ.");
  const tables = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  const baseTables = tables.filter((t) => t.scope === "data:read").map((t) => t.name);
  const customerTables = tables.filter((t) => t.scope === "data:read:customers").map((t) => t.name);
  const other = tables.filter((t) => t.scope !== "data:read" && t.scope !== "data:read:customers");

  const lines: string[] = [
    "-- flexi MCP: dedicated read-only logins for the query tools.",
    "-- Review, then run as a user with CREATEROLE (psql -f). Re-run after installing or removing modules.",
    "",
  ];
  for (const role of [reader, customers]) {
    lines.push(
      "DO $$",
      "BEGIN",
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN`,
      `    CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 10;`,
      "  END IF;",
      "END",
      "$$;",
      `ALTER ROLE ${role} SET default_transaction_read_only = on;`,
      `ALTER ROLE ${role} SET statement_timeout = '15s';`,
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '30s';`,
      `ALTER ROLE ${role} SET work_mem = '16MB';`,
      `-- temp_file_limit can only be set by a superuser; drop this line if you are not one.`,
      `ALTER ROLE ${role} SET temp_file_limit = '256MB';`,
      `GRANT USAGE ON SCHEMA public TO ${role};`,
      "",
    );
  }
  if (baseTables.length > 0) {
    lines.push(`GRANT SELECT ON ${baseTables.join(", ")} TO ${reader}, ${customers};`);
  }
  if (customerTables.length > 0) {
    lines.push("-- Tables with personal data: only the customers reader.");
    lines.push(`GRANT SELECT ON ${customerTables.join(", ")} TO ${customers};`);
  }
  if (other.length > 0) {
    lines.push(`-- Not granted (custom scopes, decide manually): ${other.map((t) => `${t.name} (${t.scope})`).join(", ")}`);
  }
  lines.push(
    "",
    "-- Set passwords (do not put them in this file):",
    `--   \\password ${reader}`,
    `--   \\password ${customers}`,
    "-- Then configure:",
    `--   FLEXI_MCP_DATABASE_URL: a postgres:// connection string that logs in as ${reader}`,
    `--   FLEXI_MCP_CUSTOMERS_DATABASE_URL: the same, logging in as ${customers}`,
  );
  return lines.join("\n") + "\n";
}
