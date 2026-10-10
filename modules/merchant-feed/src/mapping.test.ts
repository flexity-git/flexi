import { describe, expect, it } from "vitest";
import { buildFeedItems, DEFAULT_AVAILABILITY_MAPPING, resolveAvailability, variantTitle } from "./mapping.js";
import { categories, product, rows, STORE_URL, variant } from "./test-fixtures.js";

describe("buildFeedItems", () => {
  it("maps a visible variant to a feed item", () => {
    const [item, ...rest] = buildFeedItems(rows(), { storeUrl: STORE_URL });
    expect(rest).toHaveLength(0);
    expect(item).toEqual({
      id: "MAT-1",
      itemGroupId: "p-1",
      title: "Example Mat",
      link: "https://shop.example/example-mat/",
      imageLink: "https://cdn.shop.example/img/mat.jpg",
      price: 29.9,
      currency: "EUR",
      availability: "in_stock",
      gtin: "4006381333931",
      brand: "ExampleBrand",
      categoryGuids: ["c-mats", "c-root"],
      categoryPath: ["Sport", "Mats"],
      weightKg: 1.2,
      labels: {},
    });
  });

  it("skips deleted, hidden products and invisible variants", () => {
    const items = buildFeedItems(
      rows({
        products: [
          product(),
          product({ guid: "p-del", deleted_at: "2026-01-01T00:00:00Z" }),
          product({ guid: "p-hidden", visibility: "hidden" }),
        ],
        variants: [
          variant(),
          variant({ code: "MAT-2", visible: false }),
          variant({ code: "MAT-3", deleted_at: "2026-01-01T00:00:00Z" }),
          variant({ code: "DEL-1", product_guid: "p-del" }),
          variant({ code: "HID-1", product_guid: "p-hidden" }),
          variant({ code: "ORPHAN", product_guid: "p-unknown" }),
        ],
      }),
      { storeUrl: STORE_URL },
    );
    expect(items.map((i) => i.id)).toEqual(["MAT-1"]);
  });

  it("can publish other visibility values when configured", () => {
    const items = buildFeedItems(rows({ products: [product({ visibility: "detailOnly" })] }), {
      publishedVisibility: ["visible", "detailOnly"],
    });
    expect(items).toHaveLength(1);
  });

  it("uses the action price as sale price only when it is lower", () => {
    const [lower] = buildFeedItems(rows({ variants: [variant({ action_price_with_vat: "19.90" })] }));
    expect(lower?.salePrice).toBe(19.9);
    const [higher] = buildFeedItems(rows({ variants: [variant({ action_price_with_vat: "39.90" })] }));
    expect(higher?.salePrice).toBeUndefined();
  });

  it("keeps a missing price as NaN for the validator to reject", () => {
    const [item] = buildFeedItems(rows({ variants: [variant({ price_with_vat: null })] }));
    expect(Number.isNaN(item?.price)).toBe(true);
  });

  it("leaves a relative link empty without a store URL", () => {
    const [item] = buildFeedItems(rows());
    expect(item?.link).toBe("");
  });

  it("tolerates null names in the mirror", () => {
    const [item] = buildFeedItems(
      rows({ products: [product({ name: null })], categories: [{ ...categories[0]!, name: null }, categories[1]!] }),
    );
    expect(item?.title).toBe("");
    expect(item?.categoryPath).toEqual(["Mats"]);
  });

  it("survives a category cycle", () => {
    const cyclic = [
      { ...categories[0]!, parent_guid: "c-mats" },
      categories[1]!,
    ];
    const [item] = buildFeedItems(rows({ categories: cyclic }));
    expect(item?.categoryGuids).toEqual(["c-mats", "c-root"]);
  });
});

describe("variantTitle", () => {
  it("joins product and variant names", () => {
    expect(variantTitle("Example Mat", "Blue")).toBe("Example Mat Blue");
    expect(variantTitle("Example Mat", "Example Mat Blue")).toBe("Example Mat Blue");
    expect(variantTitle("Example Mat", null)).toBe("Example Mat");
  });
});

describe("resolveAvailability", () => {
  const mapping = { ...DEFAULT_AVAILABILITY_MAPPING, preorder: ["Pre-order"], outOfStock: ["Discontinued"] };

  it("falls back to the in-stock label when the current label is empty", () => {
    expect(
      resolveAvailability(variant({ stock: 5, availability_name: null, availability_in_stock_name: "pre-order" }), mapping),
    ).toBe("preorder");
  });

  it("uses stock when no label matches", () => {
    expect(resolveAvailability(variant({ stock: 3 }), mapping)).toBe("in_stock");
    expect(resolveAvailability(variant({ stock: "0" }), mapping)).toBe("out_of_stock");
    expect(resolveAvailability(variant({ stock: -2 }), mapping)).toBe("out_of_stock");
  });

  it("lets a configured label win over stock, case-insensitively", () => {
    expect(resolveAvailability(variant({ stock: 0, availability_name: "pre-ORDER" }), mapping)).toBe("preorder");
    expect(resolveAvailability(variant({ stock: 5, availability_name: "Discontinued" }), mapping)).toBe("out_of_stock");
  });

  it("falls back to the untracked default when stock is null", () => {
    expect(resolveAvailability(variant({ stock: null, availability_name: "Ask us" }), mapping)).toBe("in_stock");
    expect(
      resolveAvailability(variant({ stock: null, availability_name: "Ask us" }), { ...mapping, untracked: "out_of_stock" }),
    ).toBe("out_of_stock");
  });
});
