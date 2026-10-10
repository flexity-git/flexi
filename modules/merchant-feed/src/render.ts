import type { FeedItem, FeedName } from "./types.js";
import { CUSTOM_LABELS } from "./types.js";
import { element, formatPrice, xmlEscape } from "./xml.js";

export interface RenderOptions {
  /** Channel title for the Google feed. */
  title?: string;
  /** Public store URL, used as the Google channel link. */
  storeUrl?: string;
  /**
   * Heureka and Zbozi: DELIVERY_DATE in days for items that are not in stock.
   * When unset, the element is left out for those items.
   */
  deliveryDaysNotInStock?: number;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';
const GOOGLE_NS = "http://base.google.com/ns/1.0";
const ZBOZI_NS = "http://www.zbozi.cz/ns/offer/1.0";
const ZBOZI_NAME_MAX = 255;

function effectivePrice(item: FeedItem): number {
  return item.salePrice ?? item.price;
}

function compact(lines: Array<string | null>): string {
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** Item groups with a single member are not variants, so they get no group id. */
function multiVariantGroups(items: readonly FeedItem[]): Set<string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.itemGroupId, (counts.get(item.itemGroupId) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([group]) => group));
}

/**
 * Google Merchant Center product feed: RSS 2.0 with the `g:` namespace.
 * Spec: https://support.google.com/merchants/answer/7052112
 * The mirror has no descriptions, so `description` repeats the title.
 */
export function renderGoogle(items: readonly FeedItem[], options: RenderOptions = {}): string {
  const groups = multiVariantGroups(items);
  const out: string[] = [
    XML_DECLARATION,
    `<rss version="2.0" xmlns:g="${GOOGLE_NS}">`,
    "<channel>",
    compact([
      element("title", options.title ?? "Product feed", "  "),
      element("link", options.storeUrl, "  "),
      element("description", options.title ?? "Product feed", "  "),
    ]),
  ];
  for (const item of items) {
    const lines: Array<string | null> = [
      "  <item>",
      element("g:id", item.id, "    "),
      element("title", item.title, "    "),
      element("description", item.title, "    "),
      element("link", item.link, "    "),
      element("g:image_link", item.imageLink, "    "),
      element("g:availability", item.availability, "    "),
      element("g:price", `${formatPrice(item.price)} ${item.currency}`, "    "),
      item.salePrice !== undefined ? element("g:sale_price", `${formatPrice(item.salePrice)} ${item.currency}`, "    ") : null,
      element("g:brand", item.brand, "    "),
      element("g:gtin", item.gtin, "    "),
      element("g:condition", "new", "    "),
      element("g:product_type", item.categoryPath.join(" > "), "    "),
      groups.has(item.itemGroupId) ? element("g:item_group_id", item.itemGroupId, "    ") : null,
      item.weightKg !== undefined ? element("g:shipping_weight", `${item.weightKg} kg`, "    ") : null,
      ...CUSTOM_LABELS.map((label) => element(`g:${label}`, item.labels[label], "    ")),
      "  </item>",
    ];
    out.push(compact(lines));
  }
  out.push("</channel>", "</rss>", "");
  return out.join("\n");
}

/** Heureka and Zbozi accept only letters, digits, `_` and `-` in ITEM_ID (max 36). */
export function comparisonItemId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 36);
}

function deliveryDate(item: FeedItem, options: RenderOptions): string | null {
  if (item.availability === "in_stock") return "0";
  return options.deliveryDaysNotInStock !== undefined ? String(options.deliveryDaysNotInStock) : null;
}

function shopItem(item: FeedItem, options: RenderOptions, groups: Set<string>, feed: "heureka" | "zbozi"): string {
  const name = feed === "zbozi" ? item.title.slice(0, ZBOZI_NAME_MAX) : item.title;
  return compact([
    "  <SHOPITEM>",
    element("ITEM_ID", comparisonItemId(item.id), "    "),
    element("PRODUCTNAME", name, "    "),
    element("PRODUCT", name, "    "),
    element("URL", item.link, "    "),
    element("IMGURL", item.imageLink, "    "),
    element("PRICE_VAT", formatPrice(effectivePrice(item)), "    "),
    feed === "zbozi" ? element("BRAND", item.brand, "    ") : null,
    element("MANUFACTURER", item.brand, "    "),
    element("CATEGORYTEXT", item.categoryPath.join(" | "), "    "),
    element("EAN", item.gtin, "    "),
    feed === "zbozi" ? element("PRODUCTNO", item.id, "    ") : null,
    groups.has(item.itemGroupId) ? element("ITEMGROUP_ID", item.itemGroupId, "    ") : null,
    element("DELIVERY_DATE", deliveryDate(item, options), "    "),
    "  </SHOPITEM>",
  ]);
}

/**
 * Heureka product feed (heureka.cz, heureka.sk). Spec: https://heureka.github.io/xml-feed-specs/
 * CATEGORYTEXT uses the shop's own category path; mapping to Heureka's
 * category tree is not part of v0.1.
 */
export function renderHeureka(items: readonly FeedItem[], options: RenderOptions = {}): string {
  const groups = multiVariantGroups(items);
  return [XML_DECLARATION, "<SHOP>", ...items.map((i) => shopItem(i, options, groups, "heureka")), "</SHOP>", ""].join("\n");
}

/** Zbozi.cz product feed. Spec: https://napoveda.seznam.cz/cz/zbozi/specifikace-xml-pro-obchody/ */
export function renderZbozi(items: readonly FeedItem[], options: RenderOptions = {}): string {
  const groups = multiVariantGroups(items);
  return [
    XML_DECLARATION,
    `<SHOP xmlns="${xmlEscape(ZBOZI_NS)}">`,
    ...items.map((i) => shopItem(i, options, groups, "zbozi")),
    "</SHOP>",
    "",
  ].join("\n");
}

export function render(feed: FeedName, items: readonly FeedItem[], options: RenderOptions = {}): string {
  switch (feed) {
    case "google":
      return renderGoogle(items, options);
    case "heureka":
      return renderHeureka(items, options);
    case "zbozi":
      return renderZbozi(items, options);
  }
}
