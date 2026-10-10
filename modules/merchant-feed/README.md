# @flexity/module-merchant-feed

Builds product feeds for Google Merchant Center, Heureka (CZ/SK) and Zbozi.cz from the local
Shoptet mirror (`modules/mirror`). It writes a static XML file. Hosting that file is up to you:
any static host, nginx, an S3 bucket, or whatever your comparison site can fetch. flexi runs no
hosted service.

## Tasks

```sh
flexi run merchant-feed:generate --feed=google --store=sk --out=/var/www/feeds/google-sk.xml
flexi run merchant-feed:validate --feed=heureka --store=cz
```

| Task | What it does |
|---|---|
| `generate` | Builds the feed, writes it atomically (temp file + rename in the target directory), records a row in `feed_runs`. `--force` publishes even when the circuit breaker would block. |
| `validate` | Builds the feed and reports problems. Writes no file and no `feed_runs` row. |

Both need `--feed=google|heureka|zbozi` and `--store=<key>` (a key from `FLEXI_STORES`).
Run `generate` from cron after the mirror sync, e.g. once per hour per feed.

## Pipeline

1. **Mapping.** One item per variant where the variant is visible and not deleted, and its
   product is not deleted and has a published visibility (`visible` by default).
   - `id` is the variant code, the group id is the product GUID.
   - Title is the product name plus the variant name, unless the variant name already contains it.
   - Price is `price_with_vat`; `action_price_with_vat` becomes the sale price when it is lower.
   - Product and image URLs that are relative are resolved against `SHOPTET_STORE_<KEY>_URL`.
   - Category path comes from the shop's own category tree (default category and its parents).
   - **Descriptions:** the mirror has no product descriptions. Google gets the title as
     description (Google requires one); Heureka and Zbozi get no `DESCRIPTION` element.
2. **Rules** from `feed_rules` (see below).
3. **Validation.** Errors exclude the item: missing title, link, image, price or currency, and
   duplicate codes. Warnings keep it: a GTIN with a wrong check digit is dropped from the item,
   a title over 150 characters is reported.
4. **Rendering.** Correct XML escaping; control characters that XML forbids are removed.

### Availability

| Result | When |
|---|---|
| label match | The current availability label (`availability_name`) is listed in one of the variables below. Comparison ignores case. |
| `in_stock` / `out_of_stock` | Otherwise, stock above zero or not. |
| `FLEXI_FEED_UNTRACKED_AVAILABILITY` | Stock is not tracked (null). Default `in_stock`. |

Heureka and Zbozi get `DELIVERY_DATE` 0 for in-stock items. For other items they get
`FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK` when set, otherwise no element. Zbozi expects a value on
every offer, so set the variable if you publish out-of-stock items there.

## Configuration

All optional. Label lists are separated by `|` because labels may contain commas.

| Variable | Meaning |
|---|---|
| `FLEXI_FEED_IN_STOCK_LABELS` | Availability labels that mean in stock, e.g. `Ready to ship\|In the warehouse`. |
| `FLEXI_FEED_OUT_OF_STOCK_LABELS` | Labels that mean out of stock even with stock above zero. |
| `FLEXI_FEED_PREORDER_LABELS` | Labels that mean pre-order. |
| `FLEXI_FEED_UNTRACKED_AVAILABILITY` | `in_stock`, `out_of_stock` or `preorder` for variants without stock tracking. |
| `FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK` | Whole days for Heureka/Zbozi `DELIVERY_DATE` when not in stock. |
| `FLEXI_FEED_MIN_RATIO` | Circuit breaker threshold, 0 to 1. Default `0.7`. |
| `FLEXI_FEED_VISIBILITY` | Comma-separated product visibility values to publish. Default `visible`. |

Also used: `FLEXI_DATABASE_URL` (required), `SHOPTET_STORE_<KEY>_URL` (needed when the mirror
stores relative URLs), `FLEXI_SLACK_WEBHOOK_PRODUCTS` (circuit breaker alerts).

## Rules

`feed_rules` rows are applied in ascending `id` order. Only enabled rows for the feed (or `*`)
and the store (or `store_key` null) are used. An invalid rule stops the run, because skipping
an exclude rule would publish products you chose to hide.

`match` (jsonb). Every key present must hold; a list matches when any value matches.

| Key | Matches |
|---|---|
| `brand` | Brand, case-insensitive. |
| `category_guid` | The default category or any of its parent categories. |
| `code_prefix` | Variant code prefix. |
| `price_min`, `price_max` | Inclusive bounds on the price the customer pays (sale price if any). |

An empty `match` is rejected. `action` is `exclude` (drop the item, stop evaluating) or `set`
with `set` (jsonb) holding any of `title`, `custom_label_0` ... `custom_label_4`. Later rules
override earlier ones. Custom labels are emitted in the Google feed only.

```sql
-- Hide one brand from every feed of store "sk".
insert into feed_rules (feed, store_key, "match", action)
values ('*', 'sk', '{"brand": ["Example Brand"]}', 'exclude');

-- Tag cheap items for a separate Google Ads campaign.
insert into feed_rules (feed, "match", action, "set")
values ('google', '{"price_max": 15}', 'set', '{"custom_label_0": "low-price"}');
```

No rules ship with the module.

## Circuit breaker

Before overwriting the file, `generate` compares the item count with the last run that was
actually written for the same feed and store. Below `FLEXI_FEED_MIN_RATIO` of that count (or an
empty first feed) it keeps the old file, records the run with `written = false` and posts to
the `products` Slack channel. A blocked run does not become the new baseline. When the drop is
intended (a large catalogue cleanup), rerun with `--force`.

## Tables

| Table | Scope | Content |
|---|---|---|
| `feed_rules` | `data:read` | Rules described above. |
| `feed_runs` | `data:read` | `feed`, `store_key`, `item_count`, `error_count`, `written`, `created_at`. |

## Not in v0.1

- Mapping to the Google, Heureka or Zbozi category taxonomies (`CATEGORYTEXT` uses your own tree).
- Descriptions, additional images, shipping costs, variant parameters (`PARAM`, color, size).
- Serving the file over HTTP.

## Specifications

- Google Merchant Center product data: https://support.google.com/merchants/answer/7052112
- Heureka XML feed: https://heureka.github.io/xml-feed-specs/
- Zbozi.cz XML feed: https://napoveda.seznam.cz/cz/zbozi/specifikace-xml-pro-obchody/
