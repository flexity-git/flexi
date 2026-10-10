import { isValidGtin, normalizeGtin } from "./gtin.js";
import type { FeedItem } from "./types.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  itemId: string;
  severity: Severity;
  code: string;
  message: string;
}

export interface ValidationResult {
  /** Items without errors, possibly cleaned (invalid GTIN or sale price dropped). */
  valid: FeedItem[];
  issues: ValidationIssue[];
  /** Number of items excluded because of at least one error. */
  errorCount: number;
}

/** Longest title most comparison sites show in full; longer titles get a warning. */
export const TITLE_MAX = 150;

/**
 * Checks each item and drops the ones a merchant center would reject.
 * Errors exclude the item: missing title, link, image or price, duplicate id.
 * Warnings keep the item and fix it where it is safe: an invalid GTIN is
 * removed (better no GTIN than a wrong one), an overlong title is reported.
 */
export function validateItems(items: readonly FeedItem[]): ValidationResult {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);

  const valid: FeedItem[] = [];
  const issues: ValidationIssue[] = [];
  let errorCount = 0;

  for (const original of items) {
    const item: FeedItem = { ...original, labels: { ...original.labels } };
    const own: ValidationIssue[] = [];
    const add = (severity: Severity, code: string, message: string) =>
      own.push({ itemId: item.id, severity, code, message });

    if (!item.id.trim()) add("error", "missing_id", "Variant has no code.");
    if ((counts.get(item.id) ?? 0) > 1) add("error", "duplicate_id", `Code "${item.id}" appears more than once.`);
    if (!item.title.trim()) add("error", "missing_title", "Title is empty.");
    else if (item.title.length > TITLE_MAX) add("warning", "title_too_long", `Title has ${item.title.length} characters (over ${TITLE_MAX}).`);
    if (!item.link) add("error", "missing_link", "Product URL is missing or not absolute. Set SHOPTET_STORE_<KEY>_URL.");
    else if (!/^https?:\/\//.test(item.link)) add("error", "invalid_link", "Product URL is not http(s).");
    if (!item.imageLink) add("error", "missing_image", "Variant has no image.");
    if (!Number.isFinite(item.price) || item.price <= 0) add("error", "missing_price", "Price is missing or not positive.");
    if (!/^[A-Z]{3}$/.test(item.currency)) add("error", "missing_currency", "Currency is not a 3-letter ISO code.");
    if (item.gtin !== undefined) {
      if (isValidGtin(item.gtin)) item.gtin = normalizeGtin(item.gtin);
      else {
        add("warning", "invalid_gtin", `GTIN "${item.gtin}" fails the check digit; it is left out of the feed.`);
        delete item.gtin;
      }
    }

    issues.push(...own);
    if (own.some((i) => i.severity === "error")) errorCount += 1;
    else valid.push(item);
  }
  return { valid, issues, errorCount };
}
