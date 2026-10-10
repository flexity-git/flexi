import type { FlexiConfig } from "@flexity/core";
import { z } from "zod/v4";
import type { AuditWriter } from "./audit.js";
import { describeCatalog, type CatalogTable } from "./catalog.js";
import type { ConfirmTokens } from "./confirm.js";
import type { PoolLike, Queryable } from "./db-types.js";
import { hasScope } from "./scopes.js";
import { DEFAULT_MAX_ROWS, HARD_MAX_ROWS, runReadOnlyQuery, type QueryRoles } from "./query.js";
import { describeSchema, MAX_SCHEMA_TABLES } from "./schema.js";
import {
  assertStore,
  CUSTOMER_SCOPE,
  getOrder,
  getProduct,
  listStores,
  MAX_RECENT_ORDERS,
  MAX_SEARCH_PAGES,
  recentOrders,
  searchProducts,
  type ClientFactory,
} from "./shoptet-live.js";
import { PRODUCT_VISIBILITIES, setProductVisibility, VISIBILITY_TOOL } from "./writes.js";

/** Everything a tool may use. Built once per process. */
export interface ServerDeps {
  config: FlexiConfig;
  clients: ClientFactory;
  /** Main pool (audit, tokens). Null in live-only mode. */
  db: Queryable | null;
  /**
   * Pool for `query` and `schema_describe`, separate from the audit/token pool.
   * In HTTP mode it always connects as the dedicated reader login
   * (FLEXI_MCP_DATABASE_URL). Null in live-only mode.
   */
  queryPool: PoolLike | null;
  /**
   * Pool for callers holding data:read:customers (FLEXI_MCP_CUSTOMERS_DATABASE_URL).
   * When null, those callers use `queryPool`, so the database still decides.
   */
  customersQueryPool?: PoolLike | null;
  catalog: ReadonlyMap<string, CatalogTable>;
  /** Optional Postgres roles for SET ROLE inside the query transaction. */
  queryRoles?: QueryRoles;
  /** Problems found while building the catalog, shown by data_catalog. */
  catalogWarnings: string[];
  confirm: ConfirmTokens;
  writesEnabled: boolean;
  audit: AuditWriter;
  now: () => Date;
}

export interface Caller {
  /** Token id for HTTP callers, null for stdio. */
  tokenId: number | null;
  /** Stable identity used to bind confirm tokens, e.g. `token:3` or `stdio`. */
  id: string;
  scopes: string[];
}

export interface AuditExtra {
  sql?: string;
  rowCount?: number;
  truncated?: boolean;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  scope: string;
  schema: S;
  readOnly: boolean;
  available(deps: ServerDeps): boolean;
  run(args: z.infer<S>, ctx: { deps: ServerDeps; caller: Caller; audit: AuditExtra }): Promise<unknown>;
}

function define<S extends z.ZodObject>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

const store = z.string().min(1).max(32).describe("Store key from shoptet_stores, e.g. `sk`.");
const hasDb = (d: ServerDeps) => d.db !== null && d.queryPool !== null;
const always = () => true;
const poolFor = (deps: ServerDeps, caller: Caller): PoolLike =>
  (hasScope(caller.scopes, "data:read:customers") && deps.customersQueryPool) || deps.queryPool!;

export const TOOLS: ToolDefinition[] = [
  define({
    name: "shoptet_stores",
    description:
      "List the configured Shoptet stores (keys, which one is primary, public URL). Every other Shoptet tool takes one of these keys as `store`. " +
      "Pass include_info=true to also fetch the e-shop name live from each store. API tokens are never returned.",
    scope: "shoptet:read",
    readOnly: true,
    schema: z.object({ include_info: z.boolean().optional().describe("Also call the Shoptet API for each store's name. Slower.") }),
    available: always,
    run: (a, { deps }) => listStores(deps.config, deps.clients, a.include_info ?? false),
  }),
  define({
    name: "shoptet_order_get",
    description:
      "Fetch one order live from Shoptet by its order code (the number the customer sees). Returns status, payment and shipping, prices and items. " +
      `Customer name, e-mail, phone, addresses and remarks are only included when the caller has the ${CUSTOMER_SCOPE} scope. ` +
      "Item prices are reported as Shoptet sends them; check whether a figure is per unit or a row total before multiplying by amount.",
    scope: "shoptet:read",
    readOnly: true,
    schema: z.object({ store, code: z.string().min(1).max(64).describe("Order code, e.g. `2026000123`.") }),
    available: always,
    run: (a, { deps, caller }) => {
      assertStore(deps.config, a.store);
      return getOrder(deps.clients, a.store, a.code, caller.scopes);
    },
  }),
  define({
    name: "shoptet_orders_recent",
    description:
      `Recent orders live from Shoptet, created since \`since\` (default: last 24 hours), optionally for one status id. Capped at ${MAX_RECENT_ORDERS} orders. ` +
      "When `truncated` is true more orders match than were returned: do not compute revenue or counts from the list, narrow the window instead (or query the local mirror). " +
      `Personal data needs the ${CUSTOMER_SCOPE} scope. Cancelled orders are included unless you filter by status.`,
    scope: "shoptet:read",
    readOnly: true,
    schema: z.object({
      store,
      since: z.string().max(40).optional().describe("ISO date or date-time, e.g. `2026-10-01` or `2026-10-01T08:00:00Z`."),
      status_id: z.number().int().optional().describe("Shoptet order status id. Status ids differ per store."),
      limit: z.number().int().min(1).max(MAX_RECENT_ORDERS).optional().describe("Max orders to return (default 20)."),
    }),
    available: always,
    run: (a, { deps, caller }) => {
      assertStore(deps.config, a.store);
      return recentOrders(
        deps.clients,
        a.store,
        { ...(a.since ? { since: a.since } : {}), ...(a.status_id !== undefined ? { statusId: a.status_id } : {}), ...(a.limit ? { limit: a.limit } : {}) },
        caller.scopes,
        deps.now,
      );
    },
  }),
  define({
    name: "shoptet_product_get",
    description:
      "Fetch one product live from Shoptet, by product `guid` or by variant `code` (pass exactly one). Returns visibility, brand, default category and variants with price, stock and availability. " +
      "Use this to confirm the current state of a product: local mirror tables can lag behind Shoptet and may still contain deleted products. " +
      "A product with several variants has availability and price per variant, not on the product.",
    scope: "shoptet:read",
    readOnly: true,
    schema: z.object({
      store,
      guid: z.string().max(64).optional().describe("Product GUID."),
      code: z.string().max(64).optional().describe("Variant code (SKU)."),
    }),
    available: always,
    run: (a, { deps }) => {
      assertStore(deps.config, a.store);
      return getProduct(deps.clients, a.store, { ...(a.guid ? { guid: a.guid } : {}), ...(a.code ? { code: a.code } : {}) });
    },
  }),
  define({
    name: "shoptet_product_search",
    description:
      "Find products in a store by variant code or by part of the name. The code is looked up exactly; the name is matched case- and accent-insensitively " +
      `by scanning product list pages (default 5, max ${MAX_SEARCH_PAGES}). If \`complete\` is false the scan did not cover the whole catalogue, ` +
      "so a missing result does not prove the product does not exist. For large catalogues prefer the local mirror through the query tool.",
    scope: "shoptet:read",
    readOnly: true,
    schema: z.object({
      store,
      query: z.string().min(2).max(200).describe("Variant code or part of the product name."),
      max_pages: z.number().int().min(1).max(MAX_SEARCH_PAGES).optional().describe("How many list pages to scan for name matches."),
      visibility: z.enum(PRODUCT_VISIBILITIES).optional().describe("Only scan products with this visibility."),
      limit: z.number().int().min(1).max(50).optional().describe("Max name matches (default 20)."),
    }),
    available: always,
    run: (a, { deps }) => {
      assertStore(deps.config, a.store);
      return searchProducts(deps.clients, a.store, {
        query: a.query,
        ...(a.max_pages ? { maxPages: a.max_pages } : {}),
        ...(a.visibility ? { visibility: a.visibility } : {}),
        ...(a.limit ? { limit: a.limit } : {}),
      });
    },
  }),
  define({
    name: "data_catalog",
    description:
      "Start here before writing SQL. Lists every table the query tool can read, the module that owns it, a description, the scope each table needs, " +
      "and `callerScopes`: the scopes you actually hold. If a table exists but `accessible` is false, say that your token lacks the scope, not that the data does not exist. " +
      "Scope belongs to the table, so check it per table.",
    scope: "data:read",
    readOnly: true,
    schema: z.object({}),
    available: hasDb,
    run: async (_a, { deps, caller }) => ({
      ...describeCatalog(deps.catalog, caller.scopes),
      ...(deps.catalogWarnings.length > 0 ? { warnings: deps.catalogWarnings } : {}),
    }),
  }),
  define({
    name: "schema_describe",
    description:
      `Columns and types of the tables you may read, optionally filtered by part of the table name. At most ${MAX_SCHEMA_TABLES} tables per call; narrow \`pattern\` if \`truncated\` is true. ` +
      "Do not guess column names, look them up here. Read column comments: some amount columns are row totals (price times quantity), not unit prices.",
    scope: "data:read",
    readOnly: true,
    schema: z.object({ pattern: z.string().max(100).optional().describe("Part of a table name, e.g. `order`.") }),
    available: hasDb,
    run: (a, { deps, caller }) => describeSchema(poolFor(deps, caller), deps.catalog, caller.scopes, a.pattern),
  }),
  define({
    name: "query",
    description:
      "Run one read-only SELECT (or WITH ... SELECT) against allowlisted tables. Pass values through `params` and reference them as $1, $2 in SQL, never by string concatenation. " +
      `Returns at most ${DEFAULT_MAX_ROWS} rows by default (max_rows up to ${HARD_MAX_ROWS}) and about 1 MB. When \`truncated\` is true the result is incomplete: aggregate in SQL instead. ` +
      "Rejected: more than one statement, anything that writes, system schemas (pg_catalog, information_schema), schema-qualified names, any function outside a fixed allowlist of plain scalar, aggregate and window functions, tables outside data_catalog, " +
      "a CTE named like a table, WITH inside subqueries, INTERSECT, EXCEPT and WITH RECURSIVE (rewrite with NOT EXISTS or UNION), " +
      "SQL comments, dollar quoting, backslashes and E''/U&'' strings (put such values in params). " +
      "Mirror tables are only as fresh as their last sync; confirm a single product or order with the live shoptet_* tools.",
    scope: "data:read",
    readOnly: true,
    schema: z.object({
      sql: z.string().min(1).max(10_000).describe("One SELECT or WITH ... SELECT statement."),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).optional().describe("Values for $1, $2, ..."),
      max_rows: z.number().int().min(1).max(HARD_MAX_ROWS).optional(),
    }),
    available: hasDb,
    run: async (a, { deps, caller, audit }) => {
      audit.sql = a.sql;
      const out = await runReadOnlyQuery(poolFor(deps, caller), {
        sql: a.sql,
        params: a.params ?? [],
        ...(a.max_rows ? { maxRows: a.max_rows } : {}),
        scopes: caller.scopes,
        catalog: deps.catalog,
        ...(deps.queryRoles ? { roles: deps.queryRoles } : {}),
      });
      audit.rowCount = out.rowCount;
      audit.truncated = out.truncated;
      return out;
    },
  }),
  define({
    name: VISIBILITY_TOOL,
    description:
      "Change a product's visibility in Shoptet. Two steps, always: (1) call WITHOUT confirm_token to get a preview (current vs new) and a confirm_token, nothing changes; " +
      "(2) show the preview to a human and wait for approval; (3) call again with the same store, guid and visibility plus confirm_token. " +
      "The token expires after 10 minutes, works once, and only for the caller who made the preview. " +
      "If the result status is `unverified`, the write did NOT take effect even though Shoptet answered: report it as not done.",
    scope: "shoptet:write:products",
    readOnly: false,
    schema: z.object({
      store,
      guid: z.string().min(1).max(64).describe("Product GUID (not a variant code)."),
      visibility: z.enum(PRODUCT_VISIBILITIES).describe("New visibility."),
      confirm_token: z.string().max(4000).optional().describe("Token from the preview. Omit to get a preview."),
    }),
    available: (d) => d.writesEnabled,
    run: (a, { deps, caller }) => {
      assertStore(deps.config, a.store);
      return setProductVisibility({
        clients: deps.clients,
        confirm: deps.confirm,
        caller: caller.id,
        store: a.store,
        guid: a.guid,
        visibility: a.visibility,
        ...(a.confirm_token ? { confirmToken: a.confirm_token } : {}),
      });
    },
  }),
];

/** JSON Schema for MCP `tools/list`. */
export function inputSchemaOf(tool: ToolDefinition): { type: "object"; [key: string]: unknown } {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { ...schema, type: "object" };
}
