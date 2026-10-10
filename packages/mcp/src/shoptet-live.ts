import { ToolError } from "./errors.js";
import type { FlexiConfig } from "@flexity/core";
import { ShoptetApiError, toShoptetTimestamp, type ShoptetClient } from "@flexity/shoptet";
import { hasScope } from "./scopes.js";

/**
 * Live Shoptet tools. They read the Private API directly, so they need only
 * the store config and tokens, not a database.
 *
 * Responses are built from an allowlist of fields: unknown or new API fields
 * never pass through by accident. Personal data (names, e-mail, phone,
 * addresses, customer remarks) is added only for callers holding
 * `data:read:customers`.
 */

export const CUSTOMER_SCOPE = "data:read:customers";
export const MAX_RECENT_ORDERS = 100;
export const DEFAULT_RECENT_ORDERS = 20;
export const MAX_SEARCH_PAGES = 20;
export const DEFAULT_SEARCH_PAGES = 5;
export const MAX_SEARCH_RESULTS = 50;

export type ClientFactory = (storeKey: string) => ShoptetClient;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function pick(source: unknown, keys: readonly string[]): Obj {
  const src = obj(source);
  const out: Obj = {};
  if (!src) return out;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function named(value: unknown): unknown {
  const o = obj(value);
  if (!o) return value ?? null;
  return o.name ?? o.title ?? null;
}

export function canSeeCustomers(scopes: readonly string[]): boolean {
  return hasScope(scopes, CUSTOMER_SCOPE);
}

const ORDER_FIELDS = ["code", "guid", "creationTime", "changeTime", "paid", "customerGuid", "cashDeskOrder"] as const;
const ORDER_PII_FIELDS = ["fullName", "company", "email", "phone"] as const;
const ADDRESS_FIELDS = [
  "fullName",
  "company",
  "street",
  "houseNumber",
  "city",
  "district",
  "additional",
  "zip",
  "countryCode",
  "regionName",
] as const;
const PRICE_FIELDS = ["withVat", "withoutVat", "vat", "toPay", "currencyCode", "exchangeRate"] as const;
const ITEM_FIELDS = [
  "itemType",
  "code",
  "name",
  "variantName",
  "brand",
  "amount",
  "amountUnit",
  "productGuid",
  "status",
] as const;

/** Trims an order (list item or detail) to useful fields; PII only when allowed. */
export function trimOrder(order: unknown, withPii: boolean): Obj {
  const o = obj(order) ?? {};
  const out: Obj = {
    ...pick(o, ORDER_FIELDS),
    status: named(o.status),
    price: pick(o.price, PRICE_FIELDS),
  };
  if (o.shipping !== undefined) out.shipping = named(o.shipping);
  if (o.paymentMethod !== undefined) out.paymentMethod = named(o.paymentMethod);
  if (Array.isArray(o.items)) {
    out.items = o.items.map((it) => {
      const i = obj(it) ?? {};
      return {
        ...pick(i, ITEM_FIELDS),
        ...(i.status !== undefined ? { status: named(i.status) } : {}),
        itemPrice: pick(i.itemPrice, PRICE_FIELDS),
      };
    });
  }
  if (withPii) {
    Object.assign(out, pick(o, ORDER_PII_FIELDS));
    if (o.billingAddress !== undefined) out.billingAddress = pick(o.billingAddress, ADDRESS_FIELDS);
    if (o.deliveryAddress !== undefined) out.deliveryAddress = pick(o.deliveryAddress, ADDRESS_FIELDS);
    const notes = obj(o.notes);
    if (notes?.customerRemark !== undefined) out.customerRemark = notes.customerRemark;
  } else {
    out.personalData = `hidden (needs scope ${CUSTOMER_SCOPE})`;
  }
  return out;
}

const PRODUCT_FIELDS = ["guid", "name", "type", "visibility", "url", "creationTime", "changeTime"] as const;
const VARIANT_FIELDS = [
  "code",
  "ean",
  "name",
  "price",
  "actionPrice",
  "commonPrice",
  "currencyCode",
  "includingVat",
  "vatRate",
  "stock",
  "unit",
  "visible",
  "negativeStockAllowed",
] as const;

export function trimProduct(product: unknown): Obj {
  const p = obj(product) ?? {};
  const out: Obj = { ...pick(p, PRODUCT_FIELDS) };
  if (p.brand !== undefined) out.brand = named(p.brand);
  if (p.defaultCategory !== undefined) out.defaultCategory = named(p.defaultCategory);
  if (Array.isArray(p.variants)) {
    out.variantCount = p.variants.length;
    out.variants = p.variants.slice(0, 100).map((v) => {
      const vo = obj(v) ?? {};
      return {
        ...pick(vo, VARIANT_FIELDS),
        ...(vo.availability !== undefined ? { availability: named(vo.availability) } : {}),
        ...(vo.availabilityWhenSoldOut !== undefined ? { availabilityWhenSoldOut: named(vo.availabilityWhenSoldOut) } : {}),
      };
    });
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ShoptetApiError ? err.status === 404 : (err as { status?: unknown })?.status === 404;
}

function dataOf(res: unknown): Obj {
  return obj(obj(res)?.data) ?? {};
}

export function storeKeys(config: FlexiConfig): string[] {
  return config.stores.map((s) => s.key);
}

export function assertStore(config: FlexiConfig, store: string): void {
  if (!config.stores.some((s) => s.key === store)) {
    throw new ToolError(`Unknown store "${store}". Configured stores: ${storeKeys(config).join(", ") || "(none)"}.`);
  }
}

export async function listStores(config: FlexiConfig, clients: ClientFactory, includeInfo: boolean) {
  const stores = [];
  for (const s of config.stores) {
    const entry: Obj = { key: s.key, primary: s.key === config.primaryStore, url: s.url ?? null };
    if (includeInfo) {
      try {
        const info = dataOf(await clients(s.key).getEshopInfo());
        const contact = obj(info.contactInformation) ?? {};
        entry.eshop = {
          name: contact.eshopName ?? info.name ?? null,
          url: contact.url ?? info.url ?? null,
        };
      } catch (err) {
        entry.error = err instanceof ShoptetApiError ? `Shoptet API returned HTTP ${err.status}.` : "Shoptet API could not be reached.";
      }
    }
    stores.push(entry);
  }
  return { stores };
}

export async function getOrder(clients: ClientFactory, store: string, code: string, scopes: readonly string[]) {
  try {
    const res = await clients(store).getOrder(code);
    return { found: true, store, order: trimOrder(dataOf(res).order, canSeeCustomers(scopes)) };
  } catch (err) {
    if (isNotFound(err)) return { found: false, store, code, hint: "No order with this code exists in this store right now." };
    throw err;
  }
}

export async function recentOrders(
  clients: ClientFactory,
  store: string,
  input: { statusId?: number; since?: string; limit?: number },
  scopes: readonly string[],
  now: () => Date,
) {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_RECENT_ORDERS)), MAX_RECENT_ORDERS);
  const sinceDate = input.since ? new Date(input.since) : new Date(now().getTime() - 24 * 3600 * 1000);
  if (Number.isNaN(sinceDate.getTime())) throw new ToolError(`"since" is not a valid date: ${input.since}`);
  const client = clients(store);
  const withPii = canSeeCustomers(scopes);

  const collected: Obj[] = [];
  let totalCount: number | null = null;
  let pageCount = 1;
  const maxPages = 10;
  for (let page = 1; page <= pageCount && page <= maxPages && collected.length < limit; page++) {
    const res = await client.getOrders({
      page,
      itemsPerPage: Math.min(limit, 100),
      creationTimeFrom: toShoptetTimestamp(sinceDate),
      ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
    });
    const data = dataOf(res);
    const paginator = obj(data.paginator);
    totalCount = typeof paginator?.totalCount === "number" ? paginator.totalCount : totalCount;
    pageCount = typeof paginator?.pageCount === "number" ? paginator.pageCount : 1;
    for (const o of (data.orders as unknown[] | undefined) ?? []) collected.push(o as Obj);
  }
  const orders = collected
    .slice(0, limit)
    .map((o) => trimOrder(o, withPii))
    .sort((a, b) => String(b.creationTime ?? "").localeCompare(String(a.creationTime ?? "")));
  const truncated = totalCount !== null ? totalCount > orders.length : collected.length > orders.length;
  return {
    store,
    since: sinceDate.toISOString(),
    returned: orders.length,
    totalMatching: totalCount,
    truncated,
    ...(truncated
      ? { hint: "More orders match than were returned. Narrow `since` or filter by status; do not compute totals from this list." }
      : {}),
    orders,
  };
}

export async function getProduct(clients: ClientFactory, store: string, input: { guid?: string; code?: string }) {
  if (!!input.guid === !!input.code) throw new ToolError("Pass exactly one of `guid` (product) or `code` (variant code).");
  const client = clients(store);
  try {
    const res = input.guid
      ? await client.getProduct(input.guid)
      : await client.request("GET", `/api/products/code/${encodeURIComponent(input.code!)}`);
    const product = trimProduct(dataOf(res));
    return { found: true, store, lookup: input.guid ? "guid" : "code", product };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        found: false,
        store,
        hint: "Not found in Shoptet right now. A local mirror table may still contain it if it was deleted after the last sync.",
      };
    }
    throw err;
  }
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Product search. Shoptet's product list has no full-text filter that we rely
 * on, so this does two things: an exact variant-code lookup, and a
 * case- and accent-insensitive name match over at most `maxPages` list pages.
 * `complete: false` means the name scan did not cover the whole catalogue.
 */
export async function searchProducts(
  clients: ClientFactory,
  store: string,
  input: { query: string; maxPages?: number; visibility?: string; limit?: number },
) {
  const query = input.query.trim();
  if (query.length < 2) throw new ToolError("`query` needs at least 2 characters.");
  const maxPages = Math.min(Math.max(1, Math.floor(input.maxPages ?? DEFAULT_SEARCH_PAGES)), MAX_SEARCH_PAGES);
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), MAX_SEARCH_RESULTS);
  const client = clients(store);

  let codeMatch: Obj | null = null;
  if (!/\s/.test(query)) {
    try {
      codeMatch = trimProduct(dataOf(await client.request("GET", `/api/products/code/${encodeURIComponent(query)}`)));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  const needle = fold(query);
  const matches: Obj[] = [];
  let scanned = 0;
  let pageCount = 1;
  let totalCount: number | null = null;
  let page = 1;
  for (; page <= pageCount && page <= maxPages && matches.length < limit; page++) {
    const res = await client.getProducts({
      page,
      itemsPerPage: 100,
      ...(input.visibility ? { visibility: input.visibility } : {}),
    });
    const data = dataOf(res);
    const paginator = obj(data.paginator);
    pageCount = typeof paginator?.pageCount === "number" ? paginator.pageCount : 1;
    totalCount = typeof paginator?.totalCount === "number" ? paginator.totalCount : totalCount;
    for (const p of (data.products as unknown[] | undefined) ?? []) {
      scanned++;
      const name = typeof (p as Obj).name === "string" ? ((p as Obj).name as string) : "";
      if (fold(name).includes(needle) && matches.length < limit) matches.push(pick(p, PRODUCT_FIELDS));
    }
  }
  const complete = page > pageCount;
  return {
    store,
    query,
    codeMatch,
    nameMatches: matches,
    scannedProducts: scanned,
    totalProducts: totalCount,
    complete,
    ...(complete
      ? {}
      : {
          hint: `Name scan stopped after ${page - 1} page(s). Raise max_pages (up to ${MAX_SEARCH_PAGES}) or use a mirror table via the query tool for a full search.`,
        }),
  };
}
