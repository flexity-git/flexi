import type { CatalogTable } from "./catalog.js";
import type { Queryable } from "./db-types.js";
import { hasScope } from "./scopes.js";

export const MAX_SCHEMA_TABLES = 25;

export interface TableSchema {
  table: string;
  scope: string;
  description: string;
  columns: { name: string; type: string; nullable: boolean; comment: string | null }[];
}

/**
 * Columns of allowlisted tables the caller may read, filtered by an optional
 * name fragment. Reads information_schema itself, so callers never need it.
 */
export async function describeSchema(
  db: Queryable,
  catalog: ReadonlyMap<string, CatalogTable>,
  scopes: readonly string[],
  pattern?: string,
): Promise<{ tables: TableSchema[]; matchedCount: number; truncated: boolean; missing: string[] }> {
  const needle = (pattern ?? "").replace(/[*%]/g, "").trim().toLowerCase();
  const matched = [...catalog.values()]
    .filter((t) => hasScope(scopes, t.scope))
    .filter((t) => !needle || t.name.includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const truncated = matched.length > MAX_SCHEMA_TABLES;
  const wanted = matched.slice(0, MAX_SCHEMA_TABLES);
  if (wanted.length === 0) return { tables: [], matchedCount: 0, truncated: false, missing: [] };

  const res = await db.query(
    `select c.table_name, c.column_name, c.data_type, c.is_nullable,
            col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) as comment
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = any($1::text[])
      order by c.table_name, c.ordinal_position`,
    [wanted.map((t) => t.name)],
  );

  const byTable = new Map<string, TableSchema>(
    wanted.map((t) => [t.name, { table: t.name, scope: t.scope, description: t.description, columns: [] }]),
  );
  for (const r of res.rows) {
    byTable.get(r.table_name)?.columns.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      comment: r.comment ?? null,
    });
  }
  const tables = [...byTable.values()];
  // A manifest table without columns usually means its migration has not run yet.
  const missing = tables.filter((t) => t.columns.length === 0).map((t) => t.table);
  return { tables: tables.filter((t) => t.columns.length > 0), matchedCount: matched.length, truncated, missing };
}
