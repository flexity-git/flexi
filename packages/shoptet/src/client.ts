import { z } from "zod";

import { ShoptetApiError, ShoptetNetworkError } from "./errors.js";
import { safeEmit, type ShoptetEventHandler } from "./events.js";
import { createLimiter } from "./limiter.js";
import { paginate, collect, type FetchPage, type PaginateOptions } from "./pagination.js";
import {
  backoffDelayMs,
  parseRetryAfterMs,
  resolveRetryOptions,
  sleep,
  type RetryOptions,
} from "./retry.js";
import type {
  QueryParams,
  ShoptetCategoriesParams,
  ShoptetCategoriesResponse,
  ShoptetCategory,
  ShoptetEshopResponse,
  ShoptetInvoiceListItem,
  ShoptetInvoicesParams,
  ShoptetInvoicesResponse,
  ShoptetOrderListItem,
  ShoptetOrderResponse,
  ShoptetOrdersParams,
  ShoptetOrdersResponse,
  ShoptetOrderStatusesResponse,
  ShoptetPaginator,
  ShoptetProductListItem,
  ShoptetProductResponse,
  ShoptetProductsParams,
  ShoptetProductsResponse,
  ShoptetStocksResponse,
  ShoptetWebhookRegistration,
  ShoptetWebhooksResponse,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://api.myshoptet.com";
/** Shoptet's documented limit of parallel connections per token. */
export const DEFAULT_MAX_CONCURRENCY = 3;
export const SHOPTET_TOKEN_HEADER = "Shoptet-Private-API-Token";
const DEFAULT_CONTENT_TYPE = "application/vnd.shoptet.v1.0";

/** Pause when the leaky bucket reported by Shoptet is at least this full. */
const BUCKET_THRESHOLD = 0.9;
const BUCKET_PAUSE_MS = 1500;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ShoptetClientOptions {
  /** Private API token of one store. Never logged or put into errors. */
  token: string;
  baseUrl?: string;
  /** Parallel requests allowed for this client. Default 3. */
  maxConcurrency?: number;
  /** Custom fetch, e.g. for tests or proxies. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Observability hook for retries, rate limits, deprecations and pagination drift. */
  onEvent?: ShoptetEventHandler;
  retry?: RetryOptions;
  /** Per-attempt timeout. Default 30 000 ms. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: QueryParams;
  /** Serialised as JSON. */
  body?: unknown;
  /**
   * Whether a 5xx or network failure may be retried. Defaults to false for POST
   * and true otherwise. Set false for writes that are not safe to replay,
   * e.g. relative stock movements. 429 and 423 are always retried because
   * the server rejected the request without applying it.
   */
  idempotent?: boolean;
  contentType?: string;
}

/** Iteration options for the `iterate*` helpers. */
export type IterateOptions = Omit<PaginateOptions, "onEvent">;

export interface RegisterWebhooksResult {
  registered: ShoptetWebhookRegistration[];
  failed: Array<{ event: string; error: Error }>;
}

const signatureKeySchema = z.object({
  data: z.object({ signatureKey: z.string().min(1) }),
});

/** Methods available on a client returned by `createShoptetClient`. */
export interface ShoptetClient {
  /** Low-level request. `path` must be absolute on the API host, e.g. `/api/orders`. */
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  /** `paginate()` with this client's `onEvent` hook wired in. */
  paginate<T>(fetchPage: FetchPage<T>, options?: IterateOptions): AsyncGenerator<T, void, undefined>;

  getEshopInfo(options?: { include?: string }): Promise<ShoptetEshopResponse>;

  getOrders(params?: ShoptetOrdersParams): Promise<ShoptetOrdersResponse>;
  getOrder(code: string, options?: { include?: string }): Promise<ShoptetOrderResponse>;
  getOrderStatuses(): Promise<ShoptetOrderStatusesResponse>;
  iterateOrders(params?: ShoptetOrdersParams, options?: IterateOptions): AsyncGenerator<ShoptetOrderListItem, void, undefined>;

  getProducts(params?: ShoptetProductsParams): Promise<ShoptetProductsResponse>;
  getProduct(guid: string, options?: { include?: string }): Promise<ShoptetProductResponse>;
  iterateProducts(params?: ShoptetProductsParams, options?: IterateOptions): AsyncGenerator<ShoptetProductListItem, void, undefined>;

  getCategories(params?: ShoptetCategoriesParams): Promise<ShoptetCategoriesResponse>;
  /** Every category of the store, all pages. */
  getAllCategories(options?: IterateOptions): Promise<ShoptetCategory[]>;

  getInvoices(params?: ShoptetInvoicesParams): Promise<ShoptetInvoicesResponse>;
  iterateInvoices(params?: ShoptetInvoicesParams, options?: IterateOptions): AsyncGenerator<ShoptetInvoiceListItem, void, undefined>;

  getStocks(): Promise<ShoptetStocksResponse>;

  listWebhooks(options?: IterateOptions): Promise<ShoptetWebhookRegistration[]>;
  /** Registers each event separately so one rejected event does not hide the others. */
  registerWebhooks(items: Array<{ event: string; url: string }>): Promise<RegisterWebhooksResult>;
  deleteWebhook(id: number): Promise<void>;
  /** Creates a new signing key. The previous key stops being valid immediately. */
  renewWebhookSignatureKey(): Promise<{ signatureKey: string }>;
}

type HeaderBag = { get(name: string): string | null };

function readRequestId(body: unknown, headers: HeaderBag): string | null {
  if (body && typeof body === "object") {
    const md = (body as { metadata?: unknown }).metadata;
    if (md && typeof md === "object") {
      const id = (md as { requestId?: unknown }).requestId;
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return headers.get("X-Request-ID");
}

function parseBucketFilling(header: string | null): number | null {
  const m = header?.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return null;
  const filled = Number(m[1]);
  const capacity = Number(m[2]);
  return capacity > 0 ? filled / capacity : null;
}

function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 2000);
  }
}

/** Remove any accidental echo of the token from text that may reach logs. */
function redact(value: unknown, token: string): unknown {
  if (!token) return value;
  if (typeof value === "string") return value.split(token).join("[redacted]");
  if (value && typeof value === "object") {
    const json = JSON.stringify(value);
    return json.includes(token) ? (JSON.parse(json.split(token).join("[redacted]")) as unknown) : value;
  }
  return value;
}

function pageOf<T>(items: T[] | undefined, paginator: ShoptetPaginator | undefined) {
  return { items: items ?? [], paginator: paginator ?? null };
}

/**
 * Create a Shoptet Private API client for one store.
 * See https://developers.shoptet.com/ for endpoint reference.
 */
export function createShoptetClient(options: ShoptetClientOptions): ShoptetClient {
  if (!options.token || typeof options.token !== "string") {
    throw new TypeError("createShoptetClient: token is required");
  }
  const token = options.token;
  const base = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
  const baseHref = base.href.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createShoptetClient: no fetch implementation available");
  }
  const limiter = createLimiter(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const retry = resolveRetryOptions(options.retry);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const onEvent = options.onEvent;

  let notBefore = 0;
  const deprecationsSeen = new Set<string>();

  function buildUrl(path: string, query: QueryParams | undefined): URL {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new TypeError(`Shoptet request path must start with a single "/": ${path}`);
    }
    const url = new URL(baseHref + path);
    // Guard against a path that escapes the API host and would leak the token.
    if (url.origin !== base.origin) {
      throw new TypeError("Shoptet request path resolves outside the API host");
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  function observeHeaders(method: string, path: string, headers: HeaderBag): void {
    const bucketHeader = headers.get("X-RateLimit-Bucket-Filling");
    const filling = parseBucketFilling(bucketHeader);
    if (filling !== null && filling >= BUCKET_THRESHOLD && bucketHeader) {
      notBefore = Math.max(notBefore, Date.now() + BUCKET_PAUSE_MS);
      safeEmit(onEvent, {
        type: "throttle",
        method,
        path,
        bucketFilling: bucketHeader,
        delayMs: BUCKET_PAUSE_MS,
      });
    }
    const deprecated = headers.get("X-Shoptet-Deprecated");
    if (deprecated) {
      const sunset = headers.get("Sunset");
      const key = `${method} ${path} ${sunset ?? ""}`;
      if (!deprecationsSeen.has(key)) {
        deprecationsSeen.add(key);
        safeEmit(onEvent, { type: "deprecation", method, path, deprecated, sunset });
      }
    }
  }

  async function request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = buildUrl(path, opts.query);
    const pathname = url.pathname;
    const idempotent = opts.idempotent ?? method !== "POST";
    const headers: Record<string, string> = {
      [SHOPTET_TOKEN_HEADER]: token,
      "Content-Type": opts.contentType ?? DEFAULT_CONTENT_TYPE,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    for (let attempt = 1; ; attempt++) {
      const canRetry = attempt < retry.maxAttempts;
      const wait = notBefore - Date.now();
      if (wait > 0) await sleep(wait);

      let response: Response;
      let text: string;
      try {
        [response, text] = await limiter.run(async () => {
          const res = await fetchImpl(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          return [res, await res.text()] as const;
        });
      } catch (cause) {
        if (idempotent && canRetry) {
          const delayMs = backoffDelayMs(attempt, retry);
          safeEmit(onEvent, { type: "retry", method, path: pathname, attempt, reason: "network", delayMs });
          await sleep(delayMs);
          continue;
        }
        throw new ShoptetNetworkError({
          method,
          path: pathname,
          attempts: attempt,
          cause: redact(cause instanceof Error ? cause.message : cause, token),
        });
      }

      observeHeaders(method, pathname, response.headers);
      const parsed = redact(parseBody(text), token);
      if (response.ok) return parsed as T;

      const status = response.status;
      const retryAfter = response.headers.get("Retry-After");

      if ((status === 429 || status === 423) && canRetry) {
        const delayMs =
          parseRetryAfterMs(retryAfter, retry.maxRetryAfterMs) ?? backoffDelayMs(attempt, retry);
        if (status === 429) {
          safeEmit(onEvent, { type: "rate_limited", method, path: pathname, attempt, retryAfter, delayMs });
        } else {
          safeEmit(onEvent, { type: "retry", method, path: pathname, attempt, reason: "locked", status, delayMs });
        }
        await sleep(delayMs);
        continue;
      }

      if (status >= 500 && idempotent && canRetry) {
        const delayMs =
          parseRetryAfterMs(retryAfter, retry.maxRetryAfterMs) ?? backoffDelayMs(attempt, retry);
        safeEmit(onEvent, { type: "retry", method, path: pathname, attempt, reason: "server_error", status, delayMs });
        await sleep(delayMs);
        continue;
      }

      throw new ShoptetApiError({
        method,
        path: pathname,
        status,
        statusText: response.statusText,
        body: parsed,
        requestId: readRequestId(parsed, response.headers),
        attempts: attempt,
      });
    }
  }

  const get = <T>(path: string, query?: QueryParams) => request<T>("GET", path, { query });
  const withIterate = (o: IterateOptions | undefined, context: string): PaginateOptions => ({
    context,
    ...o,
    ...(onEvent ? { onEvent } : {}),
  });

  const client: ShoptetClient = {
    request,
    paginate: (fetchPage, o) => paginate(fetchPage, withIterate(o, "list")),

    getEshopInfo: (o = {}) => get("/api/eshop", { include: o.include }),

    getOrders: (params = {}) => get("/api/orders", params),
    getOrder: (code, o = {}) => get(`/api/orders/${encodeURIComponent(code)}`, { include: o.include }),
    getOrderStatuses: () => get("/api/orders/statuses"),
    iterateOrders: (params = {}, o) =>
      paginate(async ({ page, itemsPerPage }) => {
        const res = await client.getOrders({ ...params, page, itemsPerPage });
        return pageOf(res.data?.orders, res.data?.paginator);
      }, withIterate(o, "orders")),

    getProducts: (params = {}) => get("/api/products", params),
    getProduct: (guid, o = {}) => get(`/api/products/${encodeURIComponent(guid)}`, { include: o.include }),
    iterateProducts: (params = {}, o) =>
      paginate(async ({ page, itemsPerPage }) => {
        const res = await client.getProducts({ ...params, page, itemsPerPage });
        return pageOf(res.data?.products, res.data?.paginator);
      }, withIterate(o, "products")),

    getCategories: (params = {}) => get("/api/categories", params),
    getAllCategories: (o) =>
      collect(
        paginate(async ({ page, itemsPerPage }) => {
          const res = await client.getCategories({ page, itemsPerPage });
          return pageOf(res.data?.categories, res.data?.paginator);
        }, withIterate(o, "categories")),
      ),

    getInvoices: (params = {}) => get("/api/invoices", params),
    iterateInvoices: (params = {}, o) =>
      paginate(async ({ page, itemsPerPage }) => {
        const res = await client.getInvoices({ ...params, page, itemsPerPage });
        return pageOf(res.data?.invoices, res.data?.paginator);
      }, withIterate(o, "invoices")),

    getStocks: () => get("/api/stocks"),

    listWebhooks: (o) =>
      collect(
        paginate(async ({ page, itemsPerPage }) => {
          const res = await get<ShoptetWebhooksResponse>("/api/webhooks", { page, itemsPerPage });
          return pageOf(res.data?.webhooks, res.data?.paginator);
        }, withIterate(o, "webhooks")),
      ),

    async registerWebhooks(items) {
      const result: RegisterWebhooksResult = { registered: [], failed: [] };
      for (const item of items) {
        try {
          const res = await request<ShoptetWebhooksResponse>("POST", "/api/webhooks", {
            body: { data: [{ event: item.event, url: item.url }] },
          });
          result.registered.push(...(res?.data?.webhooks ?? []));
        } catch (error) {
          result.failed.push({
            event: item.event,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      return result;
    },

    async deleteWebhook(id) {
      await request("DELETE", `/api/webhooks/${encodeURIComponent(String(id))}`);
    },

    async renewWebhookSignatureKey() {
      const res = await request("POST", "/api/webhooks/renew-signature-key");
      const parsed = signatureKeySchema.safeParse(res);
      if (!parsed.success) {
        throw new Error("Shoptet renew-signature-key response did not contain a signatureKey");
      }
      return { signatureKey: parsed.data.data.signatureKey };
    },
  };

  return client;
}
