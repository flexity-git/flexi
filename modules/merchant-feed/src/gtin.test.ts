import { describe, expect, it } from "vitest";
import { isValidGtin, normalizeGtin } from "./gtin.js";

describe("isValidGtin", () => {
  it.each(["4006381333931", "96385074", "036000291452", "10036000291459"])("accepts %s", (gtin) => {
    expect(isValidGtin(gtin)).toBe(true);
  });

  it.each([
    ["wrong check digit", "4006381333932"],
    ["wrong length", "400638133393"],
    ["letters", "40063813339AB"],
    ["all zeros", "0000000000000"],
    ["empty", ""],
    ["null", null],
  ])("rejects %s", (_why, gtin) => {
    expect(isValidGtin(gtin)).toBe(false);
  });

  it("ignores spaces and hyphens", () => {
    expect(normalizeGtin(" 4006381-333931 ")).toBe("4006381333931");
    expect(isValidGtin("4006381 333931")).toBe(true);
  });
});
