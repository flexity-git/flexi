import type { FlexiModule } from "@flexity/core";
import { hasScope } from "./scopes.js";

/** One table callers may query through the `query` tool. */
export interface CatalogTable {
  name: string;
  /** Scope a caller needs to read this table. */
  scope: string;
  description: string;
  /** Module that exposes the table. */
  module: string;
}

/**
 * Tables that are never queryable, even if a module manifest lists them:
 * token hashes, the audit trail and migration bookkeeping.
 */
export const RESERVED_TABLES = new Set(["flexi_api_tokens", "mcp_audit_log", "flexi_migrations"]);

/**
 * Builds the allowlist from module manifests (`tables`).
 * Two modules exposing the same table with different scopes is a manifest bug
 * and fails loudly instead of picking one.
 */
export function buildCatalog(modules: ReadonlyArray<Pick<FlexiModule<any>, "name" | "tables">>): Map<string, CatalogTable> {
  const catalog = new Map<string, CatalogTable>();
  for (const mod of modules) {
    for (const t of mod.tables ?? []) {
      if (RESERVED_TABLES.has(t.name)) {
        throw new Error(`Module "${mod.name}" exposes reserved table "${t.name}"; it can never be queried through MCP.`);
      }
      const existing = catalog.get(t.name);
      if (existing) {
        if (existing.scope !== t.scope) {
          throw new Error(
            `Table "${t.name}" is exposed by "${existing.module}" with scope ${existing.scope} and by "${mod.name}" with scope ${t.scope}.`,
          );
        }
        continue;
      }
      catalog.set(t.name, { name: t.name, scope: t.scope, description: t.description, module: mod.name });
    }
  }
  return catalog;
}

/** The data_catalog payload: every table, whether the caller can read it, and the caller's scopes. */
export function describeCatalog(catalog: ReadonlyMap<string, CatalogTable>, scopes: readonly string[]) {
  const tables = [...catalog.values()]
    .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name))
    .map((t) => ({ ...t, accessible: hasScope(scopes, t.scope) }));
  return { callerScopes: [...scopes], tableCount: tables.length, tables };
}
