// Test-only helpers. Not exported from the package entry point.
import type { FlexiConfig } from "@flexity/core";
import { createShoptetClient, type ShoptetClient } from "@flexity/shoptet";
import { vi } from "vitest";
import type { AuditEntry } from "./audit.js";
import { buildCatalog } from "./catalog.js";
import { createConfirmTokens } from "./confirm.js";
import type { PoolLike } from "./db-types.js";
import type { Caller, ServerDeps } from "./tools.js";

export const FAKE_TOKEN = "test-token-not-real-000000";

export const config: FlexiConfig = {
  stores: [
    { key: "sk", token: FAKE_TOKEN, url: "https://shop.example" },
    { key: "cz", token: `${FAKE_TOKEN}-cz` },
  ],
  primaryStore: "sk",
  slack: {},
  timezone: "Europe/Prague",
  modules: null,
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export type Route = (url: URL, init: RequestInit) => Response | undefined;

/** A fetch mock that answers by route and records every request. */
export function mockFetch(route: Route) {
  const requests: Array<{ method: string; url: URL; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return route(url, init) ?? json({ errors: [{ errorCode: "not-found", message: "Not found" }] }, 404);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

export function clientsFor(fetchImpl: typeof fetch): (key: string) => ShoptetClient {
  const map = new Map<string, ShoptetClient>();
  return (key) => {
    const store = config.stores.find((s) => s.key === key);
    if (!store) throw new Error(`Unknown store "${key}".`);
    if (!map.has(key)) {
      map.set(key, createShoptetClient({ token: store.token, fetch: fetchImpl, retry: { maxAttempts: 1 } }));
    }
    return map.get(key)!;
  };
}

export const catalog = buildCatalog([
  {
    name: "mirror",
    tables: [
      { name: "store_products", scope: "data:read", description: "Product mirror" },
      { name: "order_customers", scope: "data:read:customers", description: "Customer contacts" },
    ],
  },
]);

export function fakePool(rows: Record<string, unknown>[] = []) {
  const statements: Array<{ text: string; values?: unknown[]; queryMode?: string }> = [];
  const client = {
    query: vi.fn(async (q: string | { text: string; values?: unknown[]; queryMode?: "extended" }, values?: unknown[]) => {
      const entry = typeof q === "string" ? { text: q, ...(values ? { values } : {}) } : q;
      statements.push(entry);
      if (entry.text.includes("flexi_q")) return { rows };
      if (entry.text.includes("information_schema.columns")) {
        return {
          rows: [
            { table_name: "store_products", column_name: "guid", data_type: "text", is_nullable: "NO", comment: null },
            { table_name: "store_products", column_name: "price", data_type: "numeric", is_nullable: "YES", comment: "Unit price" },
          ],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool: PoolLike = { connect: vi.fn(async () => client), query: client.query as PoolLike["query"] };
  return { pool, client, statements };
}

export function makeDeps(overrides: Partial<ServerDeps> & { fetchImpl?: typeof fetch } = {}) {
  const audits: AuditEntry[] = [];
  const { fetchImpl, ...rest } = overrides;
  const deps: ServerDeps = {
    config,
    clients: clientsFor(fetchImpl ?? mockFetch(() => undefined).fetchImpl),
    db: null,
    queryPool: null,
    catalog,
    catalogWarnings: [],
    confirm: createConfirmTokens({ secret: "test-secret-not-real-0000000000000000" }),
    writesEnabled: false,
    audit: async (e) => void audits.push(e),
    now: () => new Date("2026-10-10T10:00:00Z"),
    ...rest,
  };
  return { deps, audits };
}

export const caller = (scopes: string[], id = "token:1", tokenId: number | null = 1): Caller => ({ tokenId, id, scopes });

export function parseResult(res: { content: Array<{ text: string }> }): any {
  return JSON.parse(res.content[0]!.text);
}
