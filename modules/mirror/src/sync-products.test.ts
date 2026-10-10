import { describe, expect, it } from "vitest";
import { PaginationCapError, type ShoptetClient, type ShoptetProductListItem } from "@flexity/shoptet";
import { syncProductsForStore } from "./sync-products.js";
import { createFakePool, lastSyncStateWrite, silentLog } from "./test-helpers.js";

const NOW = new Date("2026-03-10T12:00:00Z");

function fakeClient(opts: { products?: ShoptetProductListItem[]; failDetailFor?: string[]; listError?: Error }): ShoptetClient {
  return {
    async *iterateProducts() {
      if (opts.listError) throw opts.listError;
      yield* opts.products ?? [];
    },
    async getEshopInfo() {
      return { data: { imageCuts: [{ name: "detail", urlPath: "https://cdn.shop.example/detail/" }] } };
    },
    async getProduct(guid: string) {
      if (opts.failDetailFor?.includes(guid)) throw new Error("HTTP 500");
      return { data: { guid, name: `Product ${guid}`, visibility: "visible", variants: [{ code: `${guid}-V1`, visible: true, image: "v1.jpg" }] } };
    },
    async getAllCategories() {
      return [{ guid: "c1", name: "Mats", parentGuid: null }];
    },
  } as unknown as ShoptetClient;
}

describe("syncProductsForStore", () => {
  it("marks missing products deleted and protects variants of products whose detail failed", async () => {
    const { pool, queries } = createFakePool();
    const result = await syncProductsForStore({
      db: pool,
      client: fakeClient({ products: [{ guid: "P1" }, { guid: "P2" }], failDetailFor: ["P2"] }),
      storeKey: "cz",
      now: NOW,
      log: silentLog,
    });
    expect(result).toMatchObject({ ok: true, products: 2, variants: 1, detailFailures: 1, categories: 1 });

    const productMark = queries.find((q) => /update shoptet_products set deleted_at/.test(q.text));
    expect(productMark?.params).toEqual(["cz", ["P1", "P2"], NOW]);
    const variantMark = queries.find((q) => /update shoptet_product_variants set deleted_at/.test(q.text));
    expect(variantMark?.params).toEqual(["cz", ["P1-V1"], ["P2"], NOW]);
    expect(queries.some((q) => /delete from shoptet_products|delete from shoptet_product_variants/.test(q.text))).toBe(false);

    const variantInsert = queries.find((q) => /insert into shoptet_product_variants/.test(q.text));
    expect(variantInsert?.params).toContain("https://cdn.shop.example/detail/v1.jpg");
  });

  it("never marks the catalogue deleted when Shoptet returns no products", async () => {
    const { pool, queries } = createFakePool();
    const result = await syncProductsForStore({ db: pool, client: fakeClient({ products: [] }), storeKey: "cz", now: NOW, log: silentLog });
    expect(result.ok).toBe(true);
    expect(queries.some((q) => /set deleted_at/.test(q.text))).toBe(false);
  });

  it("writes nothing when the product list hits the page cap", async () => {
    const { pool, queries } = createFakePool();
    const result = await syncProductsForStore({
      db: pool,
      client: fakeClient({ listError: new PaginationCapError({ context: "products", maxPages: 1000, pageCount: 1200, totalCount: null }) }),
      storeKey: "cz",
      now: NOW,
      log: silentLog,
    });
    expect(result.ok).toBe(false);
    expect(queries.some((q) => /insert into shoptet_products|set deleted_at/.test(q.text))).toBe(false);
    expect(lastSyncStateWrite(queries)).toMatchObject({ resource: "products", ok: false });
  });
});
