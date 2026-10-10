import { describe, expect, it } from "vitest";
import { readFeedSettings } from "./settings.js";

describe("readFeedSettings", () => {
  it("has safe defaults", () => {
    expect(readFeedSettings({})).toEqual({
      availability: { inStock: [], outOfStock: [], preorder: [], untracked: "in_stock" },
      minRatio: 0.7,
      publishedVisibility: ["visible"],
    });
  });

  it("reads pipe-separated labels and numbers", () => {
    const settings = readFeedSettings({
      FLEXI_FEED_PREORDER_LABELS: "Pre-order | Coming soon, in May",
      FLEXI_FEED_MIN_RATIO: "0.8",
      FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK: "14",
      FLEXI_FEED_UNTRACKED_AVAILABILITY: "out_of_stock",
    });
    expect(settings.availability.preorder).toEqual(["Pre-order", "Coming soon, in May"]);
    expect(settings.availability.untracked).toBe("out_of_stock");
    expect(settings.minRatio).toBe(0.8);
    expect(settings.deliveryDaysNotInStock).toBe(14);
  });

  it("reports every invalid value at once", () => {
    expect(() =>
      readFeedSettings({ FLEXI_FEED_MIN_RATIO: "2", FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK: "-1", FLEXI_FEED_UNTRACKED_AVAILABILITY: "maybe" }),
    ).toThrow(/UNTRACKED[\s\S]*MIN_RATIO[\s\S]*DELIVERY_DAYS/);
  });
});
