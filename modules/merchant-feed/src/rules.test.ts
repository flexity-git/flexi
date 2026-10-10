import { describe, expect, it } from "vitest";
import { applyRules, parseRule, type FeedRule, type FeedRuleRow } from "./rules.js";
import { item } from "./test-fixtures.js";

function row(over: Partial<FeedRuleRow>): FeedRuleRow {
  return { id: 1, feed: "*", store_key: null, match: { brand: "ExampleBrand" }, action: "exclude", set: null, enabled: true, ...over };
}

function rule(over: Partial<FeedRuleRow>): FeedRule {
  const parsed = parseRule(row(over));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.rule;
}

const scope = { feed: "google" as const, storeKey: "sk" };
const items = [
  item({ id: "MAT-1", brand: "ExampleBrand", price: 30 }),
  item({ id: "MAT-2", brand: "OtherBrand", price: 80, categoryGuids: ["c-blocks", "c-root"] }),
  item({ id: "BLK-1", brand: "OtherBrand", price: 10, salePrice: 5, categoryGuids: ["c-blocks", "c-root"] }),
];

describe("parseRule", () => {
  it("accepts a valid set rule and normalizes a single string to a list", () => {
    const parsed = parseRule(row({ action: "set", set: { custom_label_1: "x" }, match: { code_prefix: "MAT" } }));
    expect(parsed).toMatchObject({ ok: true, rule: { match: { code_prefix: ["MAT"] }, set: { custom_label_1: "x" } } });
  });

  it.each([
    ["empty match", { match: {} }, "match is empty"],
    ["unknown match key", { match: { colour: "red" } }, 'unknown match key "colour"'],
    ["non-numeric price", { match: { price_min: "10" } }, "match.price_min must be a number"],
    ["unknown feed", { feed: "other" }, 'unknown feed "other"'],
    ["unknown action", { action: "delete" }, 'unknown action "delete"'],
    ["set without set", { action: "set", set: null }, "set rule needs a non-empty set object"],
    ["unknown set key", { action: "set", set: { price: "1" } }, 'unknown set key "price"'],
    ["empty title", { action: "set", set: { title: " " } }, "set.title must not be empty"],
  ])("rejects %s", (_why, over, reason) => {
    expect(parseRule(row(over as Partial<FeedRuleRow>))).toEqual({ ok: false, id: "1", reason });
  });
});

describe("applyRules", () => {
  it("excludes by brand, case-insensitively", () => {
    const result = applyRules(items, [rule({ match: { brand: ["examplebrand"] } })], scope);
    expect(result.items.map((i) => i.id)).toEqual(["MAT-2", "BLK-1"]);
    expect(result.excluded).toBe(1);
    expect(result.hits).toEqual({ "1": 1 });
  });

  it("matches a category or any of its ancestors", () => {
    expect(applyRules(items, [rule({ match: { category_guid: ["c-blocks"] } })], scope).items.map((i) => i.id)).toEqual(["MAT-1"]);
    expect(applyRules(items, [rule({ match: { category_guid: "c-root" } })], scope).items).toHaveLength(0);
  });

  it("matches code prefix and price range on the price the customer pays, all conditions combined", () => {
    const r = rule({ match: { code_prefix: ["MAT", "BLK"], price_min: 5, price_max: 30 } });
    expect(applyRules(items, [r], scope).items.map((i) => i.id)).toEqual(["MAT-2"]);
  });

  it("sets title and custom labels, later rules overriding earlier ones", () => {
    const rules = [
      rule({ id: 2, action: "set", match: { brand: "OtherBrand" }, set: { custom_label_0: "second" } }),
      rule({ id: 1, action: "set", match: { brand: "OtherBrand" }, set: { custom_label_0: "first", title: "Renamed" } }),
    ];
    const result = applyRules(items, rules, scope);
    expect(result.items[1]).toMatchObject({ id: "MAT-2", title: "Renamed", labels: { custom_label_0: "second" } });
    expect(result.items[0]?.labels).toEqual({});
    expect(items[1]?.title).toBe("Example Mat");
  });

  it("stops at an exclude rule", () => {
    const rules = [
      rule({ id: 1, match: { code_prefix: "BLK" } }),
      rule({ id: 2, action: "set", match: { code_prefix: "BLK" }, set: { custom_label_0: "x" } }),
    ];
    expect(applyRules(items, rules, scope).hits).toEqual({ "1": 1 });
  });

  it("ignores disabled rules and rules for other feeds or stores", () => {
    const rules = [
      rule({ id: 1, enabled: false }),
      rule({ id: 2, feed: "heureka" }),
      rule({ id: 3, store_key: "cz" }),
    ];
    expect(applyRules(items, rules, scope).items).toHaveLength(3);
    expect(applyRules(items, [rule({ id: 4, feed: "google", store_key: "sk" })], scope).items).toHaveLength(2);
  });
});
