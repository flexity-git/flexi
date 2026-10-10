---
name: shoptet-feed-preflight
description: Use before launching or scaling a campaign that depends on a product feed (Google Merchant Center, comparison sites, marketplaces), after changing feed settings, or when feed item counts or approvals suddenly drop. Checks GTINs, images, prices, availability, sale prices and the live feed URL.
---

# Product feed preflight

A campaign is only as good as the feed behind it. Dashboards of ad platforms lag by hours
or days and show their own processed view. Check the feed itself, at its live URL, before
money goes out.

## When to use

- Before a campaign start, a budget increase or a seasonal sale.
- After changing feed generation, categories, availability texts or prices in bulk.
- When the number of items or approved items drops.

## Steps

### 1. Fetch the live feed, not a cached copy

```sh
curl -sS -o feed.xml -w "%{http_code} %{size_download} %{time_total}\n" "https://shop.example/feed.xml"
grep -c "<item>" feed.xml          # or <entry>, <SHOPITEM>, depending on format
xmllint --noout feed.xml && echo "well-formed"
```

- Status must be 200, the file must parse, and the item count must match what you expect.
- Fetch it twice a few minutes apart if the shop regenerates feeds on a schedule. A feed
  half-written at the time of fetch looks truncated.
- Never conclude "the feed is fine" from the platform dashboard. Conclude it from this file.

### 2. Item count and the circuit breaker

- Compare today's item count with the last known good count. A drop of more than a few
  percent without a known reason (discontinued range, deliberate exclusion) is a stop sign.
- If you generate feeds yourself, refuse to publish a feed that shrank sharply compared
  with the last published one, and alert instead. flexi's `merchant-feed` module has such
  a circuit breaker (by default it blocks a run below 70 % of the last written item
  count); if it blocked a run, find the cause before lowering the threshold. Publishing
  an empty or half feed can disapprove the whole account within hours, and recovery takes days.
- Also check the opposite: a sudden jump often means hidden or draft products leaked in.

### 3. Identifiers

- GTIN: only digits, length 8, 12, 13 or 14, valid check digit. Leading zeros matter, so
  never let a spreadsheet turn it into a number.
- Do not invent GTINs. If a product has none, leave the field empty and set the
  "no identifier" flag the platform expects, and send brand plus MPN.
- Duplicate GTINs across different products mean a copy-paste error in the catalog.
- Item ID must be stable (variant code). Changing IDs resets the item's history.

### 4. Images and prices

- Every item has an image URL that returns 200 and an image content type. Sample at least
  20 with `curl -sI`. Placeholders and watermarks get items disapproved.
- Price present, positive, with the right currency for the target country. VAT handling
  must match the platform's rules for that country.
- The feed price must match the price on the product page. Open a few product pages and
  compare, including variants. A mismatch is the most common disapproval reason.

### 5. Availability

- Map the shop's availability texts to the platform's fixed values (in stock, out of
  stock, preorder, backorder). Custom texts like "ships in 3 to 5 days" must map to
  something explicit; do not let them default to in stock.
- Preorder and backorder items need an availability date where the platform requires it.
- Items sold out with "allow orders when out of stock" are still a promise of delivery.
  Make sure the delivery time shown is true.

### 6. Sale prices

- A sale price needs a start and end date in the format the platform expects, with time
  zone. Without an end date an expired sale can keep running in ads.
- Sale price lower than the regular price, and the reference price is real. In the EU, a
  price reduction must refer to the lowest price of the previous 30 days; check with
  someone who knows your market's rules before inventing a "was" price.
- Check that the same sale price is live on the product page during the sale window.

### 7. Report

Report counts, not adjectives: items in feed, items with problems by type, sampled
image and page checks, and the URL and time of the fetch. If anything blocks the
campaign, say which items and why.

## Pitfalls

- A feed manager or marketplace connector can transform or override values after the
  shop exports them. Check the final feed the platform reads, not only the shop's export.
- Testing on one product with one variant. Problems hide in multi-variant products.
- Treating "processing" or "pending" in a dashboard as approved.

## Example

`curl` shows 1 842 items, last good was 2 310. Diff of IDs: 468 missing, all from one
category whose visibility was changed yesterday. Campaign start is held, category
visibility restored, feed refetched: 2 309 items, one discontinued product, go.
