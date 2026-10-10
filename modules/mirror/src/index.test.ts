import { describe, expect, it } from "vitest";
import { assertModule } from "@flexity/core";
import mirror from "./index.js";

describe("mirror manifest", () => {
  it("is a valid module with the documented tasks", () => {
    assertModule(mirror);
    expect(Object.keys(mirror.tasks).sort()).toEqual(["reconcile", "sync-orders", "sync-products", "sync-statuses"]);
  });

  it("exposes customer data only under the customers scope", () => {
    const scopes = Object.fromEntries((mirror.tables ?? []).map((t) => [t.name, t.scope]));
    expect(scopes).toEqual({
      shoptet_orders: "data:read",
      shoptet_order_customers: "data:read:customers",
      shoptet_order_items: "data:read",
      shoptet_order_statuses: "data:read",
      shoptet_products: "data:read",
      shoptet_product_variants: "data:read",
      shoptet_categories: "data:read",
      shoptet_sync_state: "data:read",
    });
  });
});
