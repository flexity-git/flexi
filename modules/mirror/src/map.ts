// Pure mapping from Shoptet payloads to mirror rows. No I/O here, so every
// rule about field meaning can be tested on synthetic payloads.

import type {
  ShoptetCategory,
  ShoptetOrderDetail,
  ShoptetOrderListItem,
  ShoptetOrderStatus,
  ShoptetProductDetail,
  ShoptetProductListItem,
} from "@flexity/shoptet";
import { field, toBool, toDate, toNum, toText } from "./util.js";

export interface OrderRow {
  code: string;
  guid: string | null;
  creationTime: Date | null;
  changeTime: Date | null;
  statusId: number | null;
  statusName: string | null;
  paid: boolean | null;
  totalWithVat: number | null;
  totalWithoutVat: number | null;
  currency: string | null;
  shippingMethod: string | null;
  paymentMethod: string | null;
}

export interface OrderCustomerRow {
  orderCode: string;
  email: string | null;
  phone: string | null;
  billingName: string | null;
  billingCompany: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingZip: string | null;
  billingCountry: string | null;
  deliveryName: string | null;
  deliveryCompany: string | null;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  deliveryZip: string | null;
  deliveryCountry: string | null;
}

export interface OrderItemRow {
  orderCode: string;
  itemId: string;
  itemType: string | null;
  productGuid: string | null;
  code: string | null;
  name: string | null;
  variantName: string | null;
  amount: number | null;
  /** Row total: Shoptet's itemPrice already includes the amount. */
  lineTotalWithVat: number | null;
  lineTotalWithoutVat: number | null;
  vatRate: number | null;
}

export interface MappedOrderDetail {
  order: OrderRow;
  customer: OrderCustomerRow;
  items: OrderItemRow[];
}

/** Header fields shared by the list and the detail payload. Contains no personal data. */
export function mapOrderHeader(order: ShoptetOrderListItem): OrderRow {
  const status = order.status;
  return {
    code: order.code,
    guid: toText(order.guid),
    creationTime: toDate(order.creationTime),
    changeTime: toDate(order.changeTime),
    statusId: toNum(status?.id),
    statusName: toText(status?.name),
    paid: toBool(order.paid),
    totalWithVat: toNum(order.price?.withVat),
    totalWithoutVat: toNum(order.price?.withoutVat),
    currency: toText(order.price?.currencyCode),
    shippingMethod: toText(field(order.shipping, "name")),
    paymentMethod: toText(field(order.paymentMethod, "name")),
  };
}

function street(address: unknown): string | null {
  const parts = [toText(field(address, "street")), toText(field(address, "houseNumber"))].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

export function mapOrderCustomer(order: ShoptetOrderDetail): OrderCustomerRow {
  const billing = order.billingAddress;
  const delivery = order.deliveryAddress;
  return {
    orderCode: order.code,
    email: toText(order.email),
    phone: toText(order.phone),
    billingName: toText(field(billing, "fullName")),
    billingCompany: toText(field(billing, "company")),
    billingStreet: street(billing),
    billingCity: toText(field(billing, "city")),
    billingZip: toText(field(billing, "zip")),
    billingCountry: toText(field(billing, "countryCode")),
    deliveryName: toText(field(delivery, "fullName")),
    deliveryCompany: toText(field(delivery, "company")),
    deliveryStreet: street(delivery),
    deliveryCity: toText(field(delivery, "city")),
    deliveryZip: toText(field(delivery, "zip")),
    deliveryCountry: toText(field(delivery, "countryCode")),
  };
}

export function mapOrderItems(order: ShoptetOrderDetail): OrderItemRow[] {
  const seen = new Set<string>();
  return (order.items ?? []).map((item, index) => {
    // Shoptet's itemId is stable per order line. Fall back to the position so
    // a payload without it still gets a unique key within the order.
    let itemId = toText(item.itemId) ?? `pos-${index + 1}`;
    if (seen.has(itemId)) itemId = `${itemId}-pos-${index + 1}`;
    seen.add(itemId);
    const price = item.itemPrice;
    return {
      orderCode: order.code,
      itemId,
      itemType: toText(item.itemType),
      productGuid: toText(item.productGuid),
      code: toText(item.code),
      name: toText(item.name),
      variantName: toText(item.variantName),
      amount: toNum(item.amount),
      lineTotalWithVat: toNum(price?.withVat),
      lineTotalWithoutVat: toNum(price?.withoutVat),
      vatRate: toNum(field(price, "vatRate") ?? item.vatRate),
    };
  });
}

export function mapOrderDetail(order: ShoptetOrderDetail): MappedOrderDetail {
  return { order: mapOrderHeader(order), customer: mapOrderCustomer(order), items: mapOrderItems(order) };
}

export interface StatusRow {
  id: number;
  name: string;
}

export function mapStatuses(statuses: readonly ShoptetOrderStatus[]): StatusRow[] {
  const out: StatusRow[] = [];
  for (const s of statuses) {
    const id = toNum(s.id);
    if (id === null || !Number.isInteger(id)) continue;
    out.push({ id, name: toText(s.name) ?? String(id) });
  }
  return out;
}

export interface ProductRow {
  guid: string;
  name: string | null;
  visibility: string | null;
  brand: string | null;
  defaultCategoryGuid: string | null;
  url: string | null;
  creationTime: Date | null;
  changeTime: Date | null;
}

export interface VariantRow {
  code: string;
  productGuid: string;
  name: string | null;
  ean: string | null;
  priceWithVat: number | null;
  actionPriceWithVat: number | null;
  currency: string | null;
  stock: number | null;
  availabilityName: string | null;
  availabilityInStockName: string | null;
  availabilitySoldOutName: string | null;
  visible: boolean | null;
  imageUrl: string | null;
  weight: number | null;
}

/** Product header from the list endpoint, used when the detail fetch failed. */
export function mapProductListItem(product: ShoptetProductListItem): ProductRow {
  return {
    guid: product.guid,
    name: toText(product.name),
    visibility: toText(product.visibility),
    brand: toText(field(product.brand, "name")),
    defaultCategoryGuid: toText(field(product.defaultCategory, "guid")),
    url: toText(product.url),
    creationTime: toDate(product.creationTime),
    changeTime: toDate(product.changeTime),
  };
}

export function mapProduct(product: ShoptetProductDetail): ProductRow {
  return mapProductListItem(product);
}

/** `actionPrice` arrives as `{price, fromDate, toDate}` or, in older payloads, a bare number. */
export function extractActionPrice(value: unknown): number | null {
  if (value && typeof value === "object") return toNum(field(value, "price"));
  return toNum(value);
}

/**
 * Shoptet returns a variant price either with or without VAT, flagged by `includingVat`.
 * The mirror always stores prices with VAT, so net prices are grossed up with `vatRate`.
 * A net price without a usable VAT rate is stored as null rather than as a wrong gross price.
 */
export function toPriceWithVat(price: number | null, includingVat: unknown, vatRate: unknown): number | null {
  if (price === null) return null;
  if (includingVat !== false) return price;
  const rate = toNum(vatRate);
  if (rate === null || rate < 0) return null;
  return Math.round(price * (1 + rate / 100) * 100) / 100;
}

/** Joins an image cut base path (from /api/eshop?include=imageCuts) and an image file name. */
export function buildImageUrl(fileName: string | null, imageBaseUrl: string | null): string | null {
  if (!fileName || !imageBaseUrl) return null;
  return `${imageBaseUrl.replace(/\/+$/, "")}/${fileName}`;
}

/** Variant image, else the product's main image, else its first image. */
export function pickImageFileName(product: ShoptetProductDetail, variant: Record<string, unknown>): string | null {
  const own = toText(variant.image);
  if (own) return own;
  const images = Array.isArray(product.images) ? (product.images as unknown[]) : [];
  const main = images.find((img) => field(img, "isMainImage") === true) ?? images[0];
  if (main === undefined) return null;
  return toText(field(main, "seoName")) ?? toText(field(main, "name"));
}

/** Preferred image cut for thumbnails, then whatever the store has. */
const IMAGE_CUT_PREFERENCE = ["detail", "big", "category", "related", "orig"];

export function pickImageBaseUrl(imageCuts: unknown): string | null {
  if (!Array.isArray(imageCuts) || imageCuts.length === 0) return null;
  for (const name of IMAGE_CUT_PREFERENCE) {
    const match = imageCuts.find((cut) => field(cut, "name") === name);
    const path = toText(field(match, "urlPath"));
    if (path) return path;
  }
  return toText(field(imageCuts[0], "urlPath"));
}

export function mapVariants(product: ShoptetProductDetail, imageBaseUrl: string | null): VariantRow[] {
  const out: VariantRow[] = [];
  for (const variant of product.variants ?? []) {
    const code = toText(variant.code);
    if (!code) continue;
    const stock = toNum(variant.stock);
    const inStockName = toText(field(variant.availability, "name"));
    const soldOutName = toText(field(variant.availabilityWhenSoldOut, "name"));
    const soldOut = stock !== null && stock <= 0;
    out.push({
      code,
      productGuid: product.guid,
      name: toText(variant.name),
      ean: toText(variant.ean),
      priceWithVat: toPriceWithVat(toNum(variant.price), variant.includingVat, variant.vatRate),
      actionPriceWithVat: toPriceWithVat(extractActionPrice(variant.actionPrice), variant.includingVat, variant.vatRate),
      currency: toText(variant.currencyCode),
      stock,
      availabilityName: soldOut ? (soldOutName ?? inStockName) : inStockName,
      availabilityInStockName: inStockName,
      availabilitySoldOutName: soldOutName,
      visible: toBool(variant.visible),
      imageUrl: buildImageUrl(pickImageFileName(product, variant), imageBaseUrl),
      weight: toNum(variant.weight),
    });
  }
  return out;
}

export interface CategoryRow {
  guid: string;
  parentGuid: string | null;
  name: string | null;
  url: string | null;
  visible: boolean | null;
}

export function mapCategory(category: ShoptetCategory): CategoryRow {
  return {
    guid: category.guid,
    parentGuid: toText(category.parentGuid),
    name: toText(category.name),
    url: toText(category.url),
    visible: toBool(category.visible),
  };
}
