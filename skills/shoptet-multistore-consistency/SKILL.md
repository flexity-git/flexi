---
name: shoptet-multistore-consistency
description: Use when one catalog runs on several Shoptet stores (for example SK, CZ, HU) and you need to compare or fix prices, availability, descriptions or visibility across them, or when a price on one store "changes by itself". Covers choosing a primary store, comparing by variant code, currency and VAT, external imports that overwrite values, and verifying on the live storefront.
---

# Keeping several Shoptet stores consistent

Each Shoptet store is a separate system with its own token, IDs, currency and VAT. There is
no built-in link between them. Consistency is something you check, not something you get.

## When to use

- Comparing the catalog across stores before a launch or a price change.
- "The price on the CZ store is wrong again" or availability differs between stores.
- Writing a module or script that reads more than one store.

## Rules

1. **One primary store is the source of truth.** In flexi it is `FLEXI_PRIMARY_STORE`
   (default: the first key in `FLEXI_STORES`). A difference on another store is a bug of
   that store, not a second valid version. Do not "merge" two versions.
   Exceptions (local pricing, a product sold only in one market) must be written down as
   explicit rules, not discovered in a diff.
2. **Compare by variant code.** Product GUIDs, category GUIDs, status IDs and stock IDs
   are different on every store. The variant `code` (SKU) is the join key. A code that
   exists on one store and not on another is a finding by itself.
3. **Compare like with like.** Prices are in different currencies and VAT rates. Compare
   either converted prices against an explicit rule (fixed price per currency, or
   primary price times rate with a rounding rule), or compare the rule's output with the
   store's value. Never compare raw numbers across currencies.
4. **Fetch everything before diffing.** Use the full paginated scan on each store (see
   `shoptet-api`). A diff against a partial scan reports products as "missing" that exist.

## Steps

1. Pull the variant list from each store (mirror tables if fresh, otherwise live). Key by
   `(code)`. Record scan counts per store next to `paginator.totalCount`.
2. Diff per field that should match: visibility, availability, price (via the rule),
   sale price and its dates, EAN, weight. Text fields only by presence (translation
   differs on purpose), unless you check translations separately.
3. Group findings by cause, not by product: "312 variants on HU have no EAN" is one fix.
4. Before fixing, check who writes that field. If a value differs every morning after you
   fixed it yesterday, something external is writing it.
5. Fix on the non-primary store (or fix the primary, if it was the primary that was
   wrong, and then propagate).
6. Verify on the live storefront: open the product page on each store, check price,
   variant selector and availability. Admin and API can disagree with what customers see
   (cached pages, price lists for customer groups, currency rounding in the template).

## External writers that overwrite you

- Feed managers, ERP or warehouse connectors, marketplace tools and CSV imports can write
  prices and availability on a schedule. They do it through the same admin or API, so the
  change looks like a manual edit.
- Symptoms: the same fields revert at the same time of day; a fixed price per currency
  is replaced by a converted one; your own sync logs many errors on the same products.
- Find the schedule (import logs in Shoptet admin, the tool's own settings) and change the
  rule there. Do not set up a second job that fights the import every hour.
- Until it is fixed, report these as "overwritten by external import", not as your bug.

## Pitfalls

- Using the product name as a key. Names differ by language and get edited.
- Forgetting that a variant can be hidden on one store and visible on another on purpose.
  Check the explicit exceptions list before reporting it.
- Rounding: prices ending in .90 or .99 per market are a rule. Encode it, or every
  converted price will look wrong.
- Comparing against a mirror that was synced at different times per store. Note the sync
  time for each store in the report.

## Example

Primary `sk`, others `cz`, `hu`. Scan: 2 410 / 2 410 / 2 398 variants. 12 codes missing on
`hu` (new products not yet created there). 57 `cz` prices differ from the per-currency
rule; all were changed at 05:00 by a scheduled feed import that maps a converted price.
Rule fixed in the import tool, prices restored, checked on three live product pages.
