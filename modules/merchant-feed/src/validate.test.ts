import { describe, expect, it } from "vitest";
import { item } from "./test-fixtures.js";
import { TITLE_MAX, validateItems } from "./validate.js";

describe("validateItems", () => {
  it("passes a complete item", () => {
    const result = validateItems([item()]);
    expect(result.valid).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it.each([
    ["missing_link", { link: "" }],
    ["missing_image", { imageLink: "" }],
    ["missing_price", { price: Number.NaN }],
    ["missing_price", { price: 0 }],
    ["missing_title", { title: "  " }],
    ["missing_currency", { currency: "" }],
  ])("excludes an item with %s", (code, over) => {
    const result = validateItems([item(over)]);
    expect(result.valid).toHaveLength(0);
    expect(result.errorCount).toBe(1);
    expect(result.issues.map((i) => i.code)).toContain(code);
  });

  it("drops an invalid GTIN but keeps the item", () => {
    const result = validateItems([item({ gtin: "4006381333932" })]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]?.gtin).toBeUndefined();
    expect(result.issues[0]).toMatchObject({ severity: "warning", code: "invalid_gtin" });
  });

  it("warns about long titles", () => {
    const result = validateItems([item({ title: "x".repeat(TITLE_MAX + 1) })]);
    expect(result.valid).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("title_too_long");
  });

  it("excludes every item with a duplicate id", () => {
    const result = validateItems([item(), item()]);
    expect(result.valid).toHaveLength(0);
    expect(result.errorCount).toBe(2);
  });

  it("does not mutate its input", () => {
    const input = item({ gtin: "123" });
    validateItems([input]);
    expect(input.gtin).toBe("123");
  });
});
