import { describe, expect, it } from "vitest";
import { callTool, visibleTools } from "./server.js";
import { caller, FAKE_TOKEN, json, makeDeps, mockFetch, parseResult } from "./test-helpers.js";

const order = {
  code: "2026000001",
  guid: "order-guid-1",
  creationTime: "2026-10-09T10:00:00+0200",
  changeTime: "2026-10-09T11:00:00+0200",
  fullName: "Jane Example",
  company: "Example s.r.o.",
  email: "jane@shop.example",
  phone: "+420000000000",
  customerGuid: "cust-1",
  ipAddress: "192.0.2.1",
  status: { id: 1, name: "New" },
  price: { withVat: "121.00", withoutVat: "100.00", vat: "21.00", currencyCode: "CZK", toPay: "121.00" },
  paid: false,
  billingAddress: { fullName: "Jane Example", street: "Example Street", houseNumber: "1", city: "Example City", zip: "00000", countryCode: "CZ" },
  deliveryAddress: { fullName: "Jane Example", street: "Example Street", city: "Example City", zip: "00000" },
  notes: { customerRemark: "Ring twice", eshopRemark: "internal" },
  items: [{ itemType: "product", code: "SKU-1", name: "Example mat", amount: "2", itemPrice: { withVat: "60.50" }, productGuid: "p-1" }],
};

const shoptet = mockFetch((url) => {
  if (url.pathname === "/api/orders/2026000001") return json({ data: { order } });
  if (url.pathname === "/api/orders") {
    return json({ data: { orders: [order], paginator: { totalCount: 3, page: 1, pageCount: 1, itemsOnPage: 1, itemsPerPage: 20 } } });
  }
  if (url.pathname === "/api/eshop") return json({ data: { contactInformation: { eshopName: "Example Shop", url: "https://shop.example" } } });
  if (url.pathname === "/api/products/code/SKU-1" || url.pathname === "/api/products/p-1") {
    return json({
      data: {
        guid: "p-1",
        name: "Example mat",
        visibility: "visible",
        type: "product",
        supplier: { name: "Hidden Supplier" },
        brand: { name: "Example Brand", code: "eb" },
        variants: [{ code: "SKU-1", price: "60.50", stock: "4", availability: { name: "In stock" }, visible: true, purchasePrice: "10.00" }],
      },
    });
  }
  if (url.pathname === "/api/products") {
    const page = Number(url.searchParams.get("page"));
    const products =
      page === 1
        ? [{ guid: "p-1", name: "Žltá podložka", visibility: "visible" }, { guid: "p-2", name: "Block", visibility: "visible" }]
        : [{ guid: "p-3", name: "Zlta lopta", visibility: "hidden" }];
    return json({ data: { products, paginator: { totalCount: 3, page, pageCount: 2, itemsOnPage: products.length, itemsPerPage: 2 } } });
  }
  return undefined;
});

describe("PII filtering", () => {
  it("hides personal data without data:read:customers", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(await callTool(deps, caller(["shoptet:read"]), "shoptet_order_get", { store: "sk", code: "2026000001" }));
    const text = JSON.stringify(res);
    for (const pii of ["Jane Example", "jane@shop.example", "+420000000000", "Example Street", "Ring twice", "192.0.2.1"]) {
      expect(text).not.toContain(pii);
    }
    expect(res.order.personalData).toMatch(/data:read:customers/);
    expect(res.order).toMatchObject({ code: "2026000001", status: "New", price: { withVat: "121.00", currencyCode: "CZK" } });
    expect(res.order.items[0]).toMatchObject({ code: "SKU-1", amount: "2", itemPrice: { withVat: "60.50" } });
  });

  it("hides personal data when data:read:customers is held without data:read", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(
      await callTool(deps, caller(["shoptet:read", "data:read:customers"]), "shoptet_order_get", { store: "sk", code: "2026000001" }),
    );
    expect(JSON.stringify(res)).not.toContain("jane@shop.example");
  });

  it("includes personal data with data:read + data:read:customers, still never unknown fields", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(
      await callTool(deps, caller(["shoptet:read", "data:read", "data:read:customers"]), "shoptet_order_get", {
        store: "sk",
        code: "2026000001",
      }),
    );
    expect(res.order).toMatchObject({ email: "jane@shop.example", phone: "+420000000000", customerRemark: "Ring twice" });
    expect(res.order.billingAddress.street).toBe("Example Street");
    expect(JSON.stringify(res)).not.toContain("192.0.2.1");
    expect(JSON.stringify(res)).not.toContain("internal");
  });

  it("filters PII in recent orders and flags truncation", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(await callTool(deps, caller(["shoptet:read"]), "shoptet_orders_recent", { store: "sk", status_id: 1 }));
    expect(JSON.stringify(res)).not.toContain("jane@shop.example");
    expect(res).toMatchObject({ returned: 1, totalMatching: 3, truncated: true, since: "2026-10-09T10:00:00.000Z" });
    const req = shoptet.requests.find((r) => r.url.pathname === "/api/orders")!;
    expect(req.url.searchParams.get("statusId")).toBe("1");
    expect(req.url.searchParams.get("creationTimeFrom")).toBe("2026-10-09T12:00:00+0200");
  });
});

describe("live tools", () => {
  it("shoptet_stores never returns tokens", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = await callTool(deps, caller(["shoptet:read"]), "shoptet_stores", { include_info: true });
    expect(res.content[0]!.text).not.toContain(FAKE_TOKEN);
    expect(parseResult(res).stores[0]).toEqual({ key: "sk", primary: true, url: "https://shop.example", eshop: { name: "Example Shop", url: "https://shop.example" } });
  });

  it("gets a product by code and trims unknown fields such as purchase price and supplier", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(await callTool(deps, caller(["shoptet:read"]), "shoptet_product_get", { store: "sk", code: "SKU-1" }));
    expect(res.product).toMatchObject({ guid: "p-1", brand: "Example Brand", variantCount: 1 });
    expect(res.product.variants[0]).toEqual({ code: "SKU-1", price: "60.50", stock: "4", visible: true, availability: "In stock" });
    expect(JSON.stringify(res)).not.toMatch(/Hidden Supplier|purchasePrice/);
  });

  it("reports not found instead of failing", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const res = parseResult(await callTool(deps, caller(["shoptet:read"]), "shoptet_product_get", { store: "sk", guid: "missing" }));
    expect(res.found).toBe(false);
  });

  it("requires exactly one of guid or code, and a configured store", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const both = await callTool(deps, caller(["shoptet:read"]), "shoptet_product_get", { store: "sk", guid: "a", code: "b" });
    expect(both.isError).toBe(true);
    const unknown = await callTool(deps, caller(["shoptet:read"]), "shoptet_product_get", { store: "xx", guid: "a" });
    expect(unknown.content[0]!.text).toMatch(/Unknown store "xx"/);
  });

  it("searches by code and by accent-insensitive name across pages", async () => {
    const { deps } = makeDeps({ fetchImpl: shoptet.fetchImpl });
    const byName = parseResult(await callTool(deps, caller(["shoptet:read"]), "shoptet_product_search", { store: "sk", query: "zlta" }));
    expect(byName.nameMatches.map((p: { guid: string }) => p.guid)).toEqual(["p-1", "p-3"]);
    expect(byName).toMatchObject({ complete: true, scannedProducts: 3, codeMatch: null });
    const partial = parseResult(
      await callTool(deps, caller(["shoptet:read"]), "shoptet_product_search", { store: "sk", query: "SKU-1", max_pages: 1 }),
    );
    expect(partial.codeMatch.guid).toBe("p-1");
    expect(partial.complete).toBe(false);
    expect(partial.hint).toMatch(/max_pages/);
  });
});

describe("tool visibility", () => {
  it("lists only tools the caller has scopes for and hides SQL tools without a database", () => {
    const { deps } = makeDeps();
    expect(visibleTools(deps, caller(["shoptet:read"])).map((t) => t.name)).toEqual([
      "shoptet_stores",
      "shoptet_order_get",
      "shoptet_orders_recent",
      "shoptet_product_get",
      "shoptet_product_search",
    ]);
    expect(visibleTools(deps, caller(["data:read"]))).toEqual([]);
  });

  it("rejects a call to a tool the caller cannot see, and audits it", async () => {
    const { deps, audits } = makeDeps();
    const res = await callTool(deps, caller(["data:read"]), "shoptet_order_get", { store: "sk", code: "1" });
    expect(res.isError).toBe(true);
    expect(audits[0]).toMatchObject({ tool: "shoptet_order_get", tokenId: 1, error: expect.stringMatching(/lacks its scope/) });
  });

  it("rejects invalid arguments", async () => {
    const { deps } = makeDeps();
    const res = await callTool(deps, caller(["shoptet:read"]), "shoptet_order_get", { store: "sk" });
    expect(res.content[0]!.text).toMatch(/Invalid arguments: code/);
  });
});

describe("Shoptet errors", () => {
  it("returns only the HTTP status and error codes, never the response body", async () => {
    const failing = mockFetch(() => json({ errors: [{ errorCode: "invalid-request", message: "Secret detail jane@shop.example" }] }, 400));
    const { deps, audits } = makeDeps({ fetchImpl: failing.fetchImpl });
    const res = await callTool(deps, caller(["shoptet:read"]), "shoptet_order_get", { store: "sk", code: "1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^Shoptet API returned HTTP 400 \(invalid-request\)\. Reference [0-9a-f]{8}\.$/);
    expect(res.content[0]!.text).not.toContain("Secret detail");
    expect(audits[0]!.error).toContain("Secret detail");
  });
});
