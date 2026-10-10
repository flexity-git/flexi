// Response and parameter types for the Shoptet Private API.
// Shapes are intentionally loose: the API is large and adds fields over time,
// so only commonly used fields are typed and everything else stays reachable
// through the index signature. Reference: https://developers.shoptet.com/

import type { ShoptetErrorItem } from "./errors.js";

/** Pagination block returned by list endpoints. */
export interface ShoptetPaginator {
  totalCount: number;
  page: number;
  pageCount: number;
  itemsOnPage: number;
  itemsPerPage: number;
}

/** Common envelope of every Shoptet response. */
export interface ShoptetEnvelope<TData> {
  data: TData;
  errors?: ShoptetErrorItem[] | null;
  metadata?: { requestId?: string; [key: string]: unknown } | null;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** Parameters every list endpoint understands. */
export interface ShoptetListParams {
  page?: number;
  itemsPerPage?: number;
}

export interface ShoptetPrice {
  vat?: number | string | null;
  toPay?: number | string | null;
  currencyCode?: string | null;
  withVat?: number | string | null;
  withoutVat?: number | string | null;
  [key: string]: unknown;
}

// ─── E-shop ─────────────────────────────────────────────────────────────────

export interface ShoptetEshopInfo {
  [key: string]: unknown;
}

export type ShoptetEshopResponse = ShoptetEnvelope<ShoptetEshopInfo>;

// ─── Orders ─────────────────────────────────────────────────────────────────

export interface ShoptetOrderStatus {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface ShoptetOrderListItem {
  code: string;
  guid?: string | null;
  creationTime?: string | null;
  changeTime?: string | null;
  fullName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  customerGuid?: string | null;
  status?: ShoptetOrderStatus;
  price?: ShoptetPrice;
  paid?: boolean | null;
  [key: string]: unknown;
}

export interface ShoptetOrderItem {
  code?: string | null;
  itemType?: string;
  name?: string;
  variantName?: string | null;
  amount?: string | number;
  itemPrice?: ShoptetPrice;
  productGuid?: string | null;
  [key: string]: unknown;
}

export interface ShoptetOrderDetail extends ShoptetOrderListItem {
  items?: ShoptetOrderItem[];
  billingAddress?: Record<string, unknown> | null;
  deliveryAddress?: Record<string, unknown> | null;
}

export interface ShoptetOrdersParams extends ShoptetListParams {
  statusId?: number;
  creationTimeFrom?: string;
  creationTimeTo?: string;
  changeTimeFrom?: string;
  changeTimeTo?: string;
  codeFrom?: string;
  codeTo?: string;
  email?: string;
  [key: string]: QueryValue;
}

export type ShoptetOrdersResponse = ShoptetEnvelope<{
  orders: ShoptetOrderListItem[];
  paginator: ShoptetPaginator;
}>;

export type ShoptetOrderResponse = ShoptetEnvelope<{ order: ShoptetOrderDetail }>;

export type ShoptetOrderStatusesResponse = ShoptetEnvelope<{
  statuses: ShoptetOrderStatus[];
  defaultStatus?: number | null;
  [key: string]: unknown;
}>;

// ─── Products ───────────────────────────────────────────────────────────────

export interface ShoptetProductListItem {
  guid: string;
  name?: string;
  type?: string;
  url?: string | null;
  visibility?: string;
  creationTime?: string | null;
  changeTime?: string | null;
  [key: string]: unknown;
}

export interface ShoptetProductDetail extends ShoptetProductListItem {
  variants?: Array<{ code: string; [key: string]: unknown }>;
}

export interface ShoptetProductsParams extends ShoptetListParams {
  creationTimeFrom?: string;
  creationTimeTo?: string;
  changeTimeFrom?: string;
  visibility?: string;
  type?: string;
  brandCode?: string;
  [key: string]: QueryValue;
}

export type ShoptetProductsResponse = ShoptetEnvelope<{
  products: ShoptetProductListItem[];
  paginator: ShoptetPaginator;
}>;

export type ShoptetProductResponse = ShoptetEnvelope<ShoptetProductDetail>;

// ─── Categories ─────────────────────────────────────────────────────────────

export interface ShoptetCategory {
  guid: string;
  name?: string | null;
  url?: string | null;
  parentGuid?: string | null;
  [key: string]: unknown;
}

export type ShoptetCategoriesParams = ShoptetListParams & Record<string, QueryValue>;

export type ShoptetCategoriesResponse = ShoptetEnvelope<{
  categories: ShoptetCategory[];
  paginator?: ShoptetPaginator;
}>;

// ─── Invoices ───────────────────────────────────────────────────────────────

export interface ShoptetInvoiceListItem {
  code: string;
  orderCode?: string | null;
  isValid?: boolean;
  creationTime?: string | null;
  changeTime?: string | null;
  dueDate?: string | null;
  taxDate?: string | null;
  price?: ShoptetPrice;
  [key: string]: unknown;
}

export interface ShoptetInvoicesParams extends ShoptetListParams {
  creationTimeFrom?: string;
  creationTimeTo?: string;
  taxDateFrom?: string;
  isValid?: boolean;
  orderCode?: string;
  codeFrom?: string;
  codeTo?: string;
  varSymbol?: string;
  [key: string]: QueryValue;
}

export type ShoptetInvoicesResponse = ShoptetEnvelope<{
  invoices: ShoptetInvoiceListItem[];
  paginator: ShoptetPaginator;
}>;

// ─── Stocks ─────────────────────────────────────────────────────────────────

export interface ShoptetStock {
  id: number;
  title?: string;
  isDeliveryPoint?: boolean;
  [key: string]: unknown;
}

export type ShoptetStocksResponse = ShoptetEnvelope<{
  stocks: ShoptetStock[];
  defaultStockId?: number;
}>;

// ─── Webhooks (registration API) ────────────────────────────────────────────

export interface ShoptetWebhookRegistration {
  id: number;
  event: string;
  url: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export type ShoptetWebhooksResponse = ShoptetEnvelope<{
  webhooks: ShoptetWebhookRegistration[];
  paginator?: ShoptetPaginator;
}>;
