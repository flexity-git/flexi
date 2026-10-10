import { describe, expect, it } from "vitest";
import type { ShoptetOrderDetail, ShoptetProductDetail } from "@flexity/shoptet";
import {
  buildImageUrl,
  extractActionPrice,
  mapCategory,
  mapOrderDetail,
  mapOrderHeader,
  mapProductListItem,
  mapStatuses,
  mapVariants,
  pickImageBaseUrl,
  toPriceWithVat,
} from "./map.js";

const orderDetail: ShoptetOrderDetail = {
  code: "2026000123",
  guid: "00000000-0000-4000-8000-000000000001",
  creationTime: "2026-03-01T10:15:00+0100",
  changeTime: "2026-03-02T08:00:00+0100",
  email: "jane@shop.example",
  phone: "+420000000000",
  fullName: "Jane Example",
  status: { id: -2, name: "Vyřizuje se" },
  paid: true,
  price: { withVat: "121.00", withoutVat: "100.00", currencyCode: "CZK", vat: "21.00" },
  shipping: { name: "Pickup point" },
  paymentMethod: { name: "Card" },
  billingAddress: {
    fullName: "Jane Example",
    company: "Example s.r.o.",
    street: "Example Street",
    houseNumber: "1",
    city: "Example City",
    zip: "00000",
    countryCode: "CZ",
  },
  deliveryAddress: { fullName: "Jane Example", street: "Other Street", city: "Example City", zip: "00001", countryCode: "CZ" },
  items: [
    {
      itemId: 501,
      itemType: "product",
      code: "SKU-1",
      name: "Example mat",
      variantName: "Blue",
      amount: "3.000",
      productGuid: "11111111-0000-4000-8000-000000000001",
      itemPrice: { withVat: "90.00", withoutVat: "74.38", vatRate: "21.00" },
    },
    { itemType: "shipping", name: "Pickup point", amount: "1", itemPrice: { withVat: "31.00", withoutVat: "25.62" } },
  ],
};

describe("order mapping", () => {
  it("maps the header without personal data", () => {
    const { order } = mapOrderDetail(orderDetail);
    expect(order).toEqual({
      code: "2026000123",
      guid: "00000000-0000-4000-8000-000000000001",
      creationTime: new Date("2026-03-01T09:15:00Z"),
      changeTime: new Date("2026-03-02T07:00:00Z"),
      statusId: -2,
      statusName: "Vyřizuje se",
      paid: true,
      totalWithVat: 121,
      totalWithoutVat: 100,
      currency: "CZK",
      shippingMethod: "Pickup point",
      paymentMethod: "Card",
    });
    const serialized = JSON.stringify(order);
    expect(serialized).not.toContain("jane@shop.example");
    expect(serialized).not.toContain("Jane Example");
  });

  it("puts personal data into the customer row", () => {
    const { customer } = mapOrderDetail(orderDetail);
    expect(customer).toMatchObject({
      orderCode: "2026000123",
      email: "jane@shop.example",
      billingName: "Jane Example",
      billingCompany: "Example s.r.o.",
      billingStreet: "Example Street 1",
      billingCountry: "CZ",
      deliveryStreet: "Other Street",
      deliveryZip: "00001",
      deliveryCompany: null,
    });
  });

  it("keeps itemPrice as a line total and never divides or multiplies it", () => {
    const { items } = mapOrderDetail(orderDetail);
    expect(items[0]).toMatchObject({
      itemId: "501",
      amount: 3,
      lineTotalWithVat: 90,
      lineTotalWithoutVat: 74.38,
      vatRate: 21,
      code: "SKU-1",
      variantName: "Blue",
    });
    expect(items[1]).toMatchObject({ itemId: "pos-2", itemType: "shipping", lineTotalWithVat: 31, vatRate: null });
  });

  it("maps a list item header with missing fields to nulls", () => {
    expect(mapOrderHeader({ code: "X1" })).toMatchObject({
      code: "X1",
      statusId: null,
      paid: null,
      totalWithVat: null,
      changeTime: null,
    });
  });

  it("maps statuses and drops entries without a numeric id", () => {
    expect(mapStatuses([{ id: 1, name: "New" }, { id: "x" as unknown as number, name: "Bad" }])).toEqual([
      { id: 1, name: "New" },
    ]);
  });
});

const product: ShoptetProductDetail = {
  guid: "22222222-0000-4000-8000-000000000001",
  name: "Example mat",
  visibility: "visible",
  url: "https://shop.example/example-mat/",
  brand: { name: "Example Brand", code: "example-brand" },
  defaultCategory: { guid: "33333333-0000-4000-8000-000000000001", name: "Mats" },
  creationTime: "2026-01-01T00:00:00+0100",
  changeTime: "2026-02-01T00:00:00+0100",
  images: [
    { name: "1.jpg", seoName: "example-mat.jpg", isMainImage: true },
    { name: "2.jpg", isMainImage: false },
  ],
  variants: [
    {
      code: "SKU-1",
      name: "Blue",
      ean: "0000000000017",
      price: "49.90",
      actionPrice: { price: "39.90", fromDate: "2026-01-01", toDate: "2026-12-31" },
      currencyCode: "EUR",
      stock: "0.000",
      availability: { id: 1, name: "In stock" },
      availabilityWhenSoldOut: { id: 2, name: "On order" },
      visible: true,
      weight: "1.250",
    },
    { code: "SKU-2", name: "Red", price: "49.90", stock: "4", availability: { id: 1, name: "In stock" }, visible: false, image: "red.jpg" },
    { code: "", name: "No code" },
  ],
};

describe("product mapping", () => {
  it("maps the product header", () => {
    expect(mapProductListItem(product)).toEqual({
      guid: "22222222-0000-4000-8000-000000000001",
      name: "Example mat",
      visibility: "visible",
      brand: "Example Brand",
      defaultCategoryGuid: "33333333-0000-4000-8000-000000000001",
      url: "https://shop.example/example-mat/",
      creationTime: new Date("2025-12-31T23:00:00Z"),
      changeTime: new Date("2026-01-31T23:00:00Z"),
    });
  });

  it("maps variants with action price, effective availability and image", () => {
    const rows = mapVariants(product, "https://cdn.shop.example/user/shop/detail/");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      code: "SKU-1",
      productGuid: product.guid,
      name: "Blue",
      ean: "0000000000017",
      priceWithVat: 49.9,
      actionPriceWithVat: 39.9,
      currency: "EUR",
      stock: 0,
      availabilityName: "On order",
      availabilityInStockName: "In stock",
      availabilitySoldOutName: "On order",
      visible: true,
      imageUrl: "https://cdn.shop.example/user/shop/detail/example-mat.jpg",
      weight: 1.25,
    });
    expect(rows[1]).toMatchObject({
      code: "SKU-2",
      stock: 4,
      availabilityName: "In stock",
      actionPriceWithVat: null,
      visible: false,
      imageUrl: "https://cdn.shop.example/user/shop/detail/red.jpg",
    });
  });

  it("grosses up prices that Shoptet returns without VAT", () => {
    expect(toPriceWithVat(100, true, "21.00")).toBe(100);
    expect(toPriceWithVat(100, undefined, "21.00")).toBe(100);
    expect(toPriceWithVat(100, false, "21.00")).toBe(121);
    expect(toPriceWithVat(41.24, false, "21.00")).toBe(49.9);
    expect(toPriceWithVat(100, false, null)).toBeNull();
    expect(toPriceWithVat(null, false, "21.00")).toBeNull();
    const [net] = mapVariants(
      { guid: "g-net", name: "Net", variants: [{ code: "NET-1", price: "100.00", includingVat: false, vatRate: "23.00", actionPrice: { price: "80.00", fromDate: "2026-01-01", toDate: "2026-12-31" } }] } as unknown as ShoptetProductDetail,
      null,
    );
    expect(net).toMatchObject({ priceWithVat: 123, actionPriceWithVat: 98.4 });
  });

  it("handles legacy and missing action prices", () => {
    expect(extractActionPrice(12.5)).toBe(12.5);
    expect(extractActionPrice({ price: null })).toBeNull();
    expect(extractActionPrice(undefined)).toBeNull();
  });

  it("picks the preferred image cut and builds URLs", () => {
    expect(
      pickImageBaseUrl([
        { name: "orig", urlPath: "https://cdn.shop.example/orig/" },
        { name: "detail", urlPath: "https://cdn.shop.example/detail/" },
      ]),
    ).toBe("https://cdn.shop.example/detail/");
    expect(pickImageBaseUrl(undefined)).toBeNull();
    expect(buildImageUrl("a.jpg", null)).toBeNull();
  });

  it("maps a category", () => {
    expect(
      mapCategory({ guid: "c1", parentGuid: null, name: "Mats", url: "https://shop.example/mats/", visible: true }),
    ).toEqual({ guid: "c1", parentGuid: null, name: "Mats", url: "https://shop.example/mats/", visible: true });
  });
});
