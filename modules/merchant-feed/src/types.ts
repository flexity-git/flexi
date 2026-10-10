/** Feeds this module can render. */
export const FEEDS = ["google", "heureka", "zbozi"] as const;
export type FeedName = (typeof FEEDS)[number];

export type Availability = "in_stock" | "out_of_stock" | "preorder";
export const AVAILABILITIES: readonly Availability[] = ["in_stock", "out_of_stock", "preorder"];

/** pg returns `numeric` columns as strings, so numeric fields accept both. */
export type NumericLike = number | string | null | undefined;

/** Row of `shoptet_products` (owned by modules/mirror). */
export interface MirrorProduct {
  guid: string;
  name: string | null;
  visibility: string | null;
  brand: string | null;
  default_category_guid: string | null;
  url: string | null;
  deleted_at: Date | string | null;
}

/** Row of `shoptet_product_variants` (owned by modules/mirror). */
export interface MirrorVariant {
  code: string;
  product_guid: string;
  name: string | null;
  ean: string | null;
  price_with_vat: NumericLike;
  action_price_with_vat: NumericLike;
  currency: string | null;
  stock: NumericLike;
  availability_name: string | null;
  availability_in_stock_name: string | null;
  visible: boolean | null;
  image_url: string | null;
  weight: NumericLike;
  deleted_at?: Date | string | null;
}

/** Row of `shoptet_categories` (owned by modules/mirror). */
export interface MirrorCategory {
  guid: string;
  parent_guid: string | null;
  name: string | null;
  url: string | null;
  visible: boolean | null;
}

export const CUSTOM_LABELS = ["custom_label_0", "custom_label_1", "custom_label_2", "custom_label_3", "custom_label_4"] as const;
export type CustomLabel = (typeof CUSTOM_LABELS)[number];

/** One offer in a feed. One item per visible variant. */
export interface FeedItem {
  /** Variant code. Unique within a store. */
  id: string;
  /** Product GUID; groups variants of one product. */
  itemGroupId: string;
  title: string;
  /** Absolute product URL, or "" when it cannot be resolved. */
  link: string;
  /** Absolute image URL, or "" when missing. */
  imageLink: string;
  /** Regular price with VAT. NaN when missing or unparsable. */
  price: number;
  /** Discounted price with VAT, only when lower than `price`. */
  salePrice?: number;
  currency: string;
  availability: Availability;
  gtin?: string;
  brand?: string;
  /** Default category and all its ancestors, leaf first. Used by rules. */
  categoryGuids: string[];
  /** Category names from root to leaf, from the shop's own tree. */
  categoryPath: string[];
  /** Weight in kilograms. */
  weightKg?: number;
  labels: Partial<Record<CustomLabel, string>>;
}
