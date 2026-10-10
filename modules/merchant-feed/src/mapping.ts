import type {
  Availability,
  FeedItem,
  MirrorCategory,
  MirrorProduct,
  MirrorVariant,
  NumericLike,
} from "./types.js";

/**
 * Maps Shoptet availability labels to feed availability. Labels are the
 * merchant's own texts (e.g. "Pre-order"), compared case-insensitively.
 */
export interface AvailabilityMapping {
  inStock: string[];
  outOfStock: string[];
  preorder: string[];
  /** Used when stock is not tracked (null) and no label matches. */
  untracked: Availability;
}

export const DEFAULT_AVAILABILITY_MAPPING: AvailabilityMapping = {
  inStock: [],
  outOfStock: [],
  preorder: [],
  untracked: "in_stock",
};

export interface MapOptions {
  /** Public store URL; relative product and image URLs are resolved against it. */
  storeUrl?: string;
  availability?: AvailabilityMapping;
  /** Product `visibility` values that are published. Default: ["visible"]. */
  publishedVisibility?: string[];
}

export interface MirrorRows {
  products: MirrorProduct[];
  variants: MirrorVariant[];
  categories: MirrorCategory[];
}

export function toNumber(value: NumericLike): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function norm(label: string | null | undefined): string {
  return (label ?? "").trim().toLowerCase();
}

/**
 * Resolution order:
 * 1. The current label matched against the configured lists. The mirror's
 *    `availability_name` already applies to the current stock level; the
 *    in-stock label is only a fallback when it is empty and stock > 0.
 * 2. Stock: > 0 is in stock, <= 0 is out of stock.
 * 3. Stock not tracked: `mapping.untracked`.
 */
export function resolveAvailability(variant: MirrorVariant, mapping: AvailabilityMapping): Availability {
  const stock = toNumber(variant.stock);
  const label =
    norm(variant.availability_name) || (stock !== undefined && stock > 0 ? norm(variant.availability_in_stock_name) : "");
  if (label) {
    if (mapping.preorder.some((l) => norm(l) === label)) return "preorder";
    if (mapping.outOfStock.some((l) => norm(l) === label)) return "out_of_stock";
    if (mapping.inStock.some((l) => norm(l) === label)) return "in_stock";
  }
  if (stock !== undefined) return stock > 0 ? "in_stock" : "out_of_stock";
  return mapping.untracked;
}

export function resolveUrl(value: string | null | undefined, base: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, base).toString();
  } catch {
    return "";
  }
}

/** Walks parent links from `guid` up to the root. Stops on cycles or unknown parents. */
export function categoryChain(guid: string | null, byGuid: Map<string, MirrorCategory>): MirrorCategory[] {
  const chain: MirrorCategory[] = [];
  const seen = new Set<string>();
  let current = guid ? byGuid.get(guid) : undefined;
  while (current && !seen.has(current.guid)) {
    seen.add(current.guid);
    chain.push(current);
    current = current.parent_guid ? byGuid.get(current.parent_guid) : undefined;
  }
  return chain;
}

/** Product name plus the variant name, unless the variant name already contains it. */
export function variantTitle(productName: string | null, variantName: string | null): string {
  const product = (productName ?? "").trim();
  const variant = (variantName ?? "").trim();
  if (!variant || variant === product) return product;
  if (variant.toLowerCase().startsWith(product.toLowerCase())) return variant;
  return `${product} ${variant}`;
}

/**
 * Builds one FeedItem per visible variant of a non-deleted product whose
 * visibility is published. Pure: no I/O, no validation (see validate.ts).
 * The mirror has no product descriptions, so FeedItem has none.
 */
export function buildFeedItems(rows: MirrorRows, options: MapOptions = {}): FeedItem[] {
  const mapping = options.availability ?? DEFAULT_AVAILABILITY_MAPPING;
  const published = new Set((options.publishedVisibility ?? ["visible"]).map(norm));
  const products = new Map<string, MirrorProduct>();
  for (const p of rows.products) {
    if (p.deleted_at) continue;
    if (!published.has(norm(p.visibility))) continue;
    products.set(p.guid, p);
  }
  const categories = new Map(rows.categories.map((c) => [c.guid, c]));

  const items: FeedItem[] = [];
  for (const v of rows.variants) {
    if (v.visible !== true || v.deleted_at) continue;
    const product = products.get(v.product_guid);
    if (!product) continue;

    const chain = categoryChain(product.default_category_guid, categories);
    const regular = toNumber(v.price_with_vat);
    const action = toNumber(v.action_price_with_vat);
    const weight = toNumber(v.weight);
    const ean = (v.ean ?? "").trim();
    const brand = (product.brand ?? "").trim();

    const item: FeedItem = {
      id: v.code,
      itemGroupId: product.guid,
      title: variantTitle(product.name, v.name),
      link: resolveUrl(product.url, options.storeUrl),
      imageLink: resolveUrl(v.image_url, options.storeUrl),
      price: regular ?? Number.NaN,
      currency: (v.currency ?? "").trim().toUpperCase(),
      availability: resolveAvailability(v, mapping),
      categoryGuids: chain.map((c) => c.guid),
      categoryPath: chain
        .map((c) => (c.name ?? "").trim())
        .filter((name) => name.length > 0)
        .reverse(),
      labels: {},
    };
    if (regular !== undefined && action !== undefined && action > 0 && action < regular) item.salePrice = action;
    if (ean) item.gtin = ean;
    if (brand) item.brand = brand;
    if (weight !== undefined && weight > 0) item.weightKg = weight;
    items.push(item);
  }
  return items;
}
