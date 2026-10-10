/** One entry of the `errors[]` array Shoptet returns on failed requests. */
export interface ShoptetErrorItem {
  errorCode?: string;
  message?: string;
  /** JSON pointer to the rejected field, e.g. `/items`. */
  instance?: string;
}

/**
 * Turn a Shoptet error body into a short readable string naming the rejected
 * fields. Unknown shapes fall back to a top-level message or a truncated dump.
 */
export function describeShoptetErrorBody(body: unknown): string {
  if (!body || typeof body !== "object") return "no error detail in response body";

  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((e) => {
        if (e && typeof e === "object") {
          const { instance, message, errorCode } = e as Record<string, unknown>;
          const pieces = [instance, message ?? errorCode].filter(
            (p): p is string => typeof p === "string" && p.length > 0,
          );
          return pieces.length > 0 ? pieces.join(": ") : JSON.stringify(e);
        }
        return String(e);
      })
      .join("; ");
  }

  const message = (body as { message?: unknown }).message;
  if (typeof message === "string" && message.length > 0) return message;

  return JSON.stringify(body).slice(0, 500);
}

/** Extract the structured `errors[]` entries from a response body. */
export function extractShoptetErrors(body: unknown): ShoptetErrorItem[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      ...(typeof e.errorCode === "string" ? { errorCode: e.errorCode } : {}),
      ...(typeof e.message === "string" ? { message: e.message } : {}),
      ...(typeof e.instance === "string" ? { instance: e.instance } : {}),
    }));
}

export interface ShoptetApiErrorInit {
  method: string;
  path: string;
  status: number;
  statusText: string;
  body: unknown;
  requestId: string | null;
  attempts: number;
}

/**
 * Non-2xx response from the Shoptet API after all retries.
 * Never carries request headers, so the API token cannot leak through it.
 */
export class ShoptetApiError extends Error {
  readonly method: string;
  /** Request path without the query string. */
  readonly path: string;
  readonly status: number;
  readonly statusText: string;
  readonly requestId: string | null;
  /** Structured entries from the response `errors[]` array. */
  readonly errors: ShoptetErrorItem[];
  /** Parsed response body (or raw text when it was not JSON). */
  readonly body: unknown;
  readonly attempts: number;

  constructor(init: ShoptetApiErrorInit) {
    const detail = describeShoptetErrorBody(init.body);
    const explained =
      detail !== "no error detail in response body" ? `: ${detail.slice(0, 300)}` : "";
    const id = init.requestId ? ` (requestId ${init.requestId})` : "";
    super(
      `Shoptet API ${init.method} ${init.path} failed with ${init.status} ${init.statusText}${id}${explained}`,
    );
    this.name = "ShoptetApiError";
    this.method = init.method;
    this.path = init.path;
    this.status = init.status;
    this.statusText = init.statusText;
    this.requestId = init.requestId;
    this.errors = extractShoptetErrors(init.body);
    this.body = init.body;
    this.attempts = init.attempts;
  }

  /** Error codes reported by Shoptet, e.g. `["invalid-parameter"]`. */
  get errorCodes(): string[] {
    return this.errors.map((e) => e.errorCode).filter((c): c is string => !!c);
  }
}

/** The request never produced an HTTP response (DNS, reset, timeout). */
export class ShoptetNetworkError extends Error {
  readonly method: string;
  readonly path: string;
  readonly attempts: number;

  constructor(init: { method: string; path: string; attempts: number; cause: unknown }) {
    const reason = init.cause instanceof Error ? init.cause.message : String(init.cause);
    super(
      `Shoptet API ${init.method} ${init.path} failed after ${init.attempts} attempt(s): ${reason}`,
      { cause: init.cause },
    );
    this.name = "ShoptetNetworkError";
    this.method = init.method;
    this.path = init.path;
    this.attempts = init.attempts;
  }
}

/**
 * Pagination stopped because the endpoint reports more pages than `maxPages`.
 * Thrown instead of returning a silently truncated result.
 */
export class PaginationCapError extends Error {
  readonly context: string;
  readonly maxPages: number;
  readonly pageCount: number;
  readonly totalCount: number | null;

  constructor(init: { context: string; maxPages: number; pageCount: number; totalCount: number | null }) {
    super(
      `Pagination of ${init.context} needs ${init.pageCount} pages but maxPages is ${init.maxPages}` +
        (init.totalCount != null ? ` (totalCount ${init.totalCount})` : "") +
        ". Raise maxPages or narrow the query.",
    );
    this.name = "PaginationCapError";
    this.context = init.context;
    this.maxPages = init.maxPages;
    this.pageCount = init.pageCount;
    this.totalCount = init.totalCount;
  }
}
