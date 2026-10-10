import type { CustomLabel, FeedItem, FeedName } from "./types.js";
import { CUSTOM_LABELS, FEEDS } from "./types.js";

/**
 * Conditions of a rule, stored as `feed_rules.match` (jsonb). Every key that is
 * present must hold (AND). A list matches when any value matches (OR).
 * - brand: exact brand, case-insensitive
 * - category_guid: the product's default category or any of its ancestors
 * - code_prefix: variant code starts with the prefix
 * - price_min / price_max: inclusive bounds on the price the customer pays
 * An empty match is invalid, so a typo cannot exclude the whole catalogue.
 */
export interface RuleMatch {
  brand?: string[];
  category_guid?: string[];
  code_prefix?: string[];
  price_min?: number;
  price_max?: number;
}

/** Overrides for `set` rules, stored as `feed_rules.set` (jsonb). */
export type RuleSet = Partial<Record<"title" | CustomLabel, string>>;

export interface FeedRule {
  id: number;
  feed: FeedName | "*";
  /** null applies to every store. */
  storeKey: string | null;
  match: RuleMatch;
  action: "exclude" | "set";
  set: RuleSet;
  enabled: boolean;
}

/** Raw `feed_rules` row as returned by pg. */
export interface FeedRuleRow {
  id: number | string;
  feed: string;
  store_key: string | null;
  match: unknown;
  action: string;
  set: unknown;
  enabled: boolean;
}

export type ParsedRule = { ok: true; rule: FeedRule } | { ok: false; id: string; reason: string };

const SET_KEYS = new Set<string>(["title", ...CUSTOM_LABELS]);

function stringList(value: unknown, key: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === "string" && v.trim() !== "")) {
    throw new Error(`match.${key} must be a non-empty string or a list of non-empty strings`);
  }
  return list.map((v: string) => v.trim());
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Validates a row. Invalid rules are reported and skipped, never guessed. */
export function parseRule(row: FeedRuleRow): ParsedRule {
  const id = String(row.id);
  try {
    if (row.feed !== "*" && !(FEEDS as readonly string[]).includes(row.feed)) throw new Error(`unknown feed "${row.feed}"`);
    if (row.action !== "exclude" && row.action !== "set") throw new Error(`unknown action "${row.action}"`);

    const rawMatch = plainObject(row.match);
    if (!rawMatch) throw new Error("match must be a JSON object");
    const match: RuleMatch = {};
    for (const [key, value] of Object.entries(rawMatch)) {
      if (key === "brand" || key === "category_guid" || key === "code_prefix") match[key] = stringList(value, key);
      else if (key === "price_min" || key === "price_max") {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`match.${key} must be a number`);
        match[key] = value;
      } else throw new Error(`unknown match key "${key}"`);
    }
    if (Object.keys(match).length === 0) throw new Error("match is empty");

    const set: RuleSet = {};
    if (row.action === "set") {
      const rawSet = plainObject(row.set);
      if (!rawSet || Object.keys(rawSet).length === 0) throw new Error("set rule needs a non-empty set object");
      for (const [key, value] of Object.entries(rawSet)) {
        if (!SET_KEYS.has(key)) throw new Error(`unknown set key "${key}"`);
        if (typeof value !== "string") throw new Error(`set.${key} must be a string`);
        if (key === "title" && value.trim() === "") throw new Error("set.title must not be empty");
        set[key as keyof RuleSet] = value;
      }
    }

    return {
      ok: true,
      rule: {
        id: Number(row.id),
        feed: row.feed as FeedRule["feed"],
        storeKey: row.store_key,
        match,
        action: row.action,
        set,
        enabled: row.enabled,
      },
    };
  } catch (err) {
    return { ok: false, id, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function ruleMatches(match: RuleMatch, item: FeedItem): boolean {
  if (match.brand) {
    const brand = (item.brand ?? "").toLowerCase();
    if (!match.brand.some((b) => b.toLowerCase() === brand)) return false;
  }
  if (match.category_guid && !match.category_guid.some((g) => item.categoryGuids.includes(g))) return false;
  if (match.code_prefix && !match.code_prefix.some((p) => item.id.startsWith(p))) return false;
  const price = item.salePrice ?? item.price;
  if (match.price_min !== undefined && !(price >= match.price_min)) return false;
  if (match.price_max !== undefined && !(price <= match.price_max)) return false;
  return true;
}

export interface RulesResult {
  items: FeedItem[];
  excluded: number;
  /** Rule id -> number of items it matched. */
  hits: Record<string, number>;
}

/**
 * Applies enabled rules for this feed and store in ascending id order.
 * An exclude rule removes the item and stops further rules for it. Set rules
 * apply in order, so a later rule overrides an earlier one.
 */
export function applyRules(
  items: readonly FeedItem[],
  rules: readonly FeedRule[],
  scope: { feed: FeedName; storeKey: string },
): RulesResult {
  const active = rules
    .filter((r) => r.enabled && (r.feed === "*" || r.feed === scope.feed) && (r.storeKey === null || r.storeKey === scope.storeKey))
    .sort((a, b) => a.id - b.id);
  const hits: Record<string, number> = {};
  const out: FeedItem[] = [];
  let excluded = 0;

  for (const original of items) {
    let item = original;
    let keep = true;
    for (const rule of active) {
      if (!ruleMatches(rule.match, item)) continue;
      hits[rule.id] = (hits[rule.id] ?? 0) + 1;
      if (rule.action === "exclude") {
        keep = false;
        break;
      }
      const { title, ...labels } = rule.set;
      item = { ...item, ...(title !== undefined ? { title } : {}), labels: { ...item.labels, ...labels } };
    }
    if (keep) out.push(item);
    else excluded += 1;
  }
  return { items: out, excluded, hits };
}
