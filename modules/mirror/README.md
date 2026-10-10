# @flexity/module-mirror

Keeps a local Postgres copy of your Shoptet data: orders (with items and customer),
order statuses, products, variants and categories, for every configured store. Other
modules and the MCP server read these tables instead of calling the Shoptet API.

It also compares the catalogue of each store against the primary store and tells you in
Slack when they drift apart.

## Setup

1. Set `FLEXI_STORES`, `SHOPTET_TOKEN_<KEY>` for each store and `FLEXI_DATABASE_URL`.
2. Run `flexi migrate`.
3. Run the first sync by hand (see "First run" below), then schedule the tasks.

## Tasks

| Task | What it does | Options |
|---|---|---|
| `mirror:sync-orders` | Incremental sync by order change time. Fetches the detail of every changed order for items and customer data. | `--store=<key>`, `--since=<ISO>`, `--max-pages=<n>` |
| `mirror:sync-products` | Full pass over products, variants and categories. | `--store=<key>`, `--max-pages=<n>` |
| `mirror:sync-statuses` | Copies the order status list. | `--store=<key>` |
| `mirror:reconcile` | Compares every store's variants with the primary store by code. Posts to the `products` channel only when there are differences. | none |

Without `--store` a task runs for every store in `FLEXI_STORES`. A failing store does not
stop the others, but the run is reported as failed.

A typical schedule: `sync-orders` every 10 to 15 minutes, `sync-statuses` once a day,
`sync-products` once or twice a day, `reconcile` after `sync-products`.

## How the order cursor works

`sync-orders` stores a cursor per store in `shoptet_sync_state` (resource `orders`) and
asks Shoptet only for orders changed since then. The cursor is conservative on purpose:

- If the detail of some order cannot be fetched, its header is still updated, but the
  cursor stops just before the earliest such order, so the next run fetches it again.
  `shoptet_orders.detail_synced` is `false` until the detail is stored.
- If the order list hits the page cap (`PaginationCapError`) or any other error stops
  the run, the cursor is not touched.
- The cursor never moves backwards. A `--since` later than the stored cursor does not
  move it either, because the gap in between was not fetched.

## First run

With no cursor, `sync-orders` reads the whole order history. For a large store this can
hit the page cap. Backfill in steps with `--since`, oldest first, for example
`flexi run mirror:sync-orders --store=sk --since=2025-01-01T00:00:00Z`, or raise the cap
with `--max-pages`.

## Deleted products

`sync-products` never deletes product or variant rows. A product missing from a complete
pass gets `deleted_at`; so does a variant missing from its product. Variants of a product
whose detail could not be fetched keep their previous state. An empty product list never
marks anything deleted. Filter `deleted_at is null` for live data.

Categories are a plain copy of the current tree: categories removed in Shoptet are removed
from `shoptet_categories`.

## Tables

| Table | Key | MCP scope |
|---|---|---|
| `shoptet_orders` | `store_key, code` | `data:read` (no personal data) |
| `shoptet_order_customers` | `store_key, order_code` | `data:read:customers` |
| `shoptet_order_items` | `store_key, order_code, item_id` | `data:read` |
| `shoptet_order_statuses` | `store_key, id` | `data:read` |
| `shoptet_products` | `store_key, guid` | `data:read` |
| `shoptet_product_variants` | `store_key, code` | `data:read` |
| `shoptet_categories` | `store_key, guid` | `data:read` |
| `shoptet_sync_state` | `store_key, resource` | `data:read` |

`shoptet_order_items.line_total_with_vat` and `line_total_without_vat` are totals for the
whole line, never unit prices. Do not multiply them by `amount`.

`shoptet_product_variants.availability_name` is the availability that applies to the
current stock (the sold-out availability when stock is zero or below);
`availability_in_stock_name` and `availability_sold_out_name` are the two values set in
Shoptet.

Columns may be added in later versions. Existing columns are not renamed or removed.

## Reconcile

The primary store is `FLEXI_PRIMARY_STORE`, or the first key in `FLEXI_STORES`. For each
other store the task reports variant codes missing in that store, codes that exist only
there, and codes whose variant `visible` flag or product `visibility` differ. Stores with
no variants in the mirror yet are skipped. Only rows without `deleted_at` are compared.
