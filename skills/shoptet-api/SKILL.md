---
name: shoptet-api
description: Use when writing or debugging code that calls the Shoptet Private API (directly or through @flexity/shoptet), when a sync returns fewer items than expected, when you see HTTP 429/423, when filtering by change time, or when setting up Shoptet webhooks and signature checks.
---

# Working with the Shoptet Private API

The reference for endpoints, parameters and fields is https://developers.shoptet.com/.
Link to it, do not copy it. This skill covers how to use the API safely and the traps
that do not show up in the reference.

## When to use

- Writing a module task, script or one-off query that reads or writes Shoptet data.
- A scan "finished" but the numbers look low, or differ between runs.
- Rate-limit errors, retries, or webhook signature failures.

## Tokens

- The Private API is only available on Shoptet plans that include it (Premium and up).
  A store without it cannot be connected; say so instead of looking for a workaround.
- Create one dedicated token per store for flexi (Shoptet admin, Private API settings).
  Do not reuse a token that another integration already uses: the concurrency limit is
  per token, so two integrations on one token throttle each other.
- Each token has rights per endpoint group. A 403 on one endpoint while others work
  usually means that group is not enabled for the token, not a bug in the code.
- In flexi the token lives in `SHOPTET_TOKEN_<KEY>` (e.g. `SHOPTET_TOKEN_SK`). Never print
  it, never put it in a URL, a log line, a test fixture or an error message.

## Use the shared client

```ts
import { createShoptetClient, toShoptetTimestamp } from "@flexity/shoptet";

const shoptet = createShoptetClient({ token, onEvent: (e) => log.info("shoptet", e) });
```

Inside a flexi task use `ctx.shoptet("sk")` instead: it returns one shared client per store.
Create one client per token and share it. Two clients on the same token double the real
concurrency and break the limit.

## Rate limits

- At most 3 concurrent requests per token. The client queues extra calls (FIFO).
- HTTP 429: wait for `Retry-After`, then retry. The client does this, capped at 60 s.
- HTTP 423 (resource locked) and 5xx: backoff with jitter. POST is not replayed after
  5xx or a network error unless you pass `idempotent: true`. Pass `idempotent: false`
  for any write that must not run twice (for example a relative stock change).
- Do not add your own `Promise.all` over hundreds of requests to "go faster". The limiter
  serialises them anyway, and a burst fills the rate-limit bucket for every other job.

## Pagination: the most common silent bug

- Shoptet sometimes ignores `itemsPerPage` and returns 10 items per page. Code that
  computes "pages = total / 100" or stops after N pages will miss most of the data.
- Always loop on `paginator.pageCount` from the response. `paginate()` and the
  `iterate*` methods do this and emit `items_per_page_ignored` when it happens.
- Never stop quietly at a page cap. `PaginationCapError` is thrown when the server
  reports more pages than `maxPages`. Catch it only to report it, never to return
  what you have so far as if it were complete.
- A partial scan looks exactly like a clean result: "0 problems found" over 10 % of the
  catalog. In every summary, report how many items were scanned next to the result,
  and compare it with `paginator.totalCount`.
- `pagination_drift` means `totalCount` changed mid-scan (items were created or changed
  while paging). Pin the window with `changeTimeTo` (or `creationTimeTo`) and rerun.

## Incremental sync

- Prefer `changeTimeFrom` over full downloads. Store the watermark as the latest
  `changeTime` you actually received, not `now()`.
- Re-read a small overlap (a few minutes before the watermark) and upsert by a stable
  key (order `code`, product `guid`, variant `code`). Duplicates are harmless, gaps are not.
- Pin the upper bound (`changeTimeTo` = start of this run) so the window is stable.
- Deletions do not appear in a change-time list. Use the `order:delete` webhook or a
  periodic full reconciliation to catch them.

## Timestamps

- Filters expect a local time with offset, e.g. `2026-03-01T10:15:00+0100`.
  Use `toShoptetTimestamp(date, timeZone)` and `parseShoptetTimestamp()`. Do not build the
  string by hand and do not send a bare date or a `Z` time unless the docs say it is accepted.
- With curl, encode `+` as `%2B`. An unencoded `+` becomes a space and the filter is
  rejected or silently ignored.
- Around daylight-saving changes the offset differs between winter and summer. Let the
  helper compute it from the time zone (`FLEXI_TIMEZONE`).

## Webhooks

- Register with `registerWebhooks([{ event, url }])`. Each event is registered separately,
  so check `failed` in the result.
- Verify every call: `verifyWebhookSignature(rawBody, header, secret)` on the raw body,
  before parsing. Get the key with `renewWebhookSignatureKey()`; renewing invalidates the
  old key immediately, so update the stored secret in the same step.
- The payload only says what changed (`event`, `eventInstance`). Fetch the current state
  through the API before acting on it.
- Answer 2xx fast and process asynchronously. Expect duplicates and occasional misses:
  keep a periodic incremental sync as the safety net.

## Quick manual check

```sh
curl -s -H "Shoptet-Private-API-Token: $SHOPTET_TOKEN_SK" \
  -H "Content-Type: application/vnd.shoptet.v1.0" \
  "https://api.myshoptet.com/api/orders?itemsPerPage=100&page=1" | jq '.data.paginator'
```

Compare `itemsPerPage` in the response with what you asked for, and `totalCount` with
what your code reports.

## Pitfalls

- Treating a 200 on a write as proof it worked. Read the entity back and compare.
- Logging full request URLs: query strings can contain customer e-mails. The client's
  events strip them; do the same in your own logs.
- Assuming the same IDs (status IDs, stock IDs, category GUIDs) across stores. They differ.
