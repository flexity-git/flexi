# @flexity/shoptet

A typed client for the [Shoptet Private API](https://developers.shoptet.com/). It has no
dependency on the rest of flexi and can be used on its own.

What it handles for you:

- a per-client concurrency limit (3 parallel requests by default)
- retries for rate limits, locked resources, server errors and network failures
- pagination that does not trust `itemsPerPage` and never truncates silently
- webhook signature verification and payload validation
- Shoptet timestamp formatting

For endpoint details, parameters and response fields, see the official documentation at
https://developers.shoptet.com/.

## Install

```sh
npm install @flexity/shoptet
```

Requires Node 20.19 or newer. The package ships TypeScript sources (ESM).

## Quick example

```ts
import { createShoptetClient, toShoptetTimestamp } from "@flexity/shoptet";

const shoptet = createShoptetClient({
  token: process.env.SHOPTET_TOKEN_SK!,
  onEvent: (event) => console.log("[shoptet]", event),
});

const info = await shoptet.getEshopInfo();

// Iterate every order changed in the last day, across all pages.
const since = toShoptetTimestamp(Date.now() - 24 * 3600 * 1000);
for await (const order of shoptet.iterateOrders({ changeTimeFrom: since })) {
  console.log(order.code, order.status?.name);
}

// Anything the typed methods do not cover:
const brands = await shoptet.request("GET", "/api/brands", { query: { page: 1 } });
```

Available methods: `getEshopInfo`, `getOrders`, `getOrder`, `getOrderStatuses`,
`iterateOrders`, `getProducts`, `getProduct`, `iterateProducts`, `getCategories`,
`getAllCategories`, `getInvoices`, `iterateInvoices`, `getStocks`, `listWebhooks`,
`registerWebhooks`, `deleteWebhook`, `renewWebhookSignatureKey`, `paginate` and the generic
`request(method, path, { query, body })`.

## Rate limits and retries

- At most `maxConcurrency` requests (default 3, the documented per-token limit) run at
  once per client. Extra calls wait in a FIFO queue. Create one client per token and share it.
- HTTP 429: the client waits for `Retry-After` (seconds or an HTTP date), capped at
  `retry.maxRetryAfterMs` (default 60 s), then retries. Without the header it uses backoff.
- HTTP 423 and 5xx: exponential backoff with jitter (`retry.baseDelayMs`, default 500 ms,
  up to `retry.maxDelayMs`, default 30 s).
- Network errors and timeouts (`timeoutMs`, default 30 s) are retried with backoff.
- `retry.maxAttempts` (default 4) counts the first attempt.
- POST requests are not replayed after a 5xx or network error, because the server may have
  applied them. Pass `idempotent: true` to `request()` to opt in, or `idempotent: false` to
  protect a non-replayable PATCH such as a relative stock movement.
- When Shoptet reports a nearly full rate-limit bucket, the client pauses briefly before
  the next request.

Failures throw `ShoptetApiError` (status, Shoptet `errors[]` with `errorCode`, `message` and
`instance`, `requestId`) or `ShoptetNetworkError`. Errors never contain the API token.

## Pagination guarantee

`paginate(fetchPage, { itemsPerPage, maxPages })` and the `iterate*` methods:

- always send `itemsPerPage` (default 100; pass `null` for endpoints that reject it),
- loop on the `paginator.pageCount` the server returns, so the result is complete even when
  Shoptet ignores `itemsPerPage` and serves 10 items per page,
- emit a `pagination_drift` event when `totalCount` changes between pages, which means items
  may have shifted; use a stable filter such as `changeTimeTo` to avoid it,
- throw `PaginationCapError` as soon as the server reports more pages than `maxPages`
  (default 1000). They never stop early without telling you.

## Events

`onEvent` receives plain objects you can log or send to telemetry:
`retry`, `rate_limited`, `throttle`, `deprecation`, `pagination_drift` and
`items_per_page_ignored`. Paths in events never include query strings. Exceptions thrown by
the hook are swallowed so logging cannot break a request.

## Webhooks

```ts
import {
  parseWebhookPayload,
  SHOPTET_WEBHOOK_SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "@flexity/shoptet";

const rawBody = await request.text();
const signature = request.headers.get(SHOPTET_WEBHOOK_SIGNATURE_HEADER);
if (!verifyWebhookSignature(rawBody, signature, process.env.SHOPTET_WEBHOOK_SECRET!)) {
  return new Response("invalid signature", { status: 401 });
}
const event = parseWebhookPayload(rawBody); // { eshopId, event, eventCreated, eventInstance }
```

Verification uses a constant-time comparison on the raw body. Register webhooks with
`registerWebhooks([{ event, url }])` and obtain the signing key with
`renewWebhookSignatureKey()`. Renewing invalidates the previous key.

## Timestamps

`toShoptetTimestamp(date, timeZone = "Europe/Prague")` returns the format Shoptet filters
expect, for example `2026-03-01T10:15:00+0100`. `parseShoptetTimestamp` reads it back.

## License

Apache-2.0
