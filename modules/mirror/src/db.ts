// Data access for the mirror tables. All SQL is parameterized; table and
// column names come from constants in this file, never from input.

import type { CategoryRow, MappedOrderDetail, OrderRow, ProductRow, StatusRow, VariantRow } from "./map.js";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface PoolClientLike extends Queryable {
  release(): void;
}
/** The subset of pg.Pool the mirror uses, so tests can pass a fake. */
export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}

export type SyncResource = "orders" | "products" | "statuses";

export interface SyncState {
  cursor: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

export function requireDb<T>(db: T | null): T {
  if (!db) throw new Error("The mirror module needs a database. Set FLEXI_DATABASE_URL and run `flexi migrate`.");
  return db;
}

export async function withTransaction<T>(pool: PoolLike, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function getSyncState(db: Queryable, storeKey: string, resource: SyncResource): Promise<SyncState> {
  const { rows } = await db.query(
    "select cursor, last_success_at, last_error from shoptet_sync_state where store_key = $1 and resource = $2",
    [storeKey, resource],
  );
  const row = rows[0];
  return {
    cursor: asDate(row?.cursor),
    lastSuccessAt: asDate(row?.last_success_at),
    lastError: (row?.last_error as string | null | undefined) ?? null,
  };
}

/**
 * Records the end of a sync run. `cursor: undefined` leaves the stored cursor
 * as it is; only a successful run (`ok`) moves last_success_at.
 */
export async function saveSyncState(
  db: Queryable,
  storeKey: string,
  resource: SyncResource,
  update: { cursor?: Date | undefined; ok: boolean; error: string | null; at: Date },
): Promise<void> {
  await db.query(
    `insert into shoptet_sync_state (store_key, resource, cursor, last_success_at, last_error, updated_at)
     values ($1, $2, $3, case when $4::boolean then $5::timestamptz end, $6, $5)
     on conflict (store_key, resource) do update set
       cursor = case when $7::boolean then excluded.cursor else shoptet_sync_state.cursor end,
       last_success_at = case when $4::boolean then $5::timestamptz else shoptet_sync_state.last_success_at end,
       last_error = $6,
       updated_at = $5`,
    [storeKey, resource, update.cursor ?? null, update.ok, update.at, update.error, update.cursor !== undefined],
  );
}

const CHUNK = 500;

/** Multi-row `insert ... on conflict do update`, in chunks to stay under the parameter limit. */
async function upsertRows(
  db: Queryable,
  table: string,
  columns: readonly string[],
  conflict: readonly string[],
  rows: readonly unknown[][],
): Promise<void> {
  const updates = columns.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`);
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await db.query(
      `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}
       on conflict (${conflict.join(", ")}) do update set ${updates.join(", ")}`,
      params,
    );
  }
}

const ORDER_COLUMNS = [
  "store_key", "code", "guid", "creation_time", "change_time", "status_id", "status_name", "paid",
  "total_with_vat", "total_without_vat", "currency", "shipping_method", "payment_method",
  "detail_synced", "synced_at",
] as const;

function orderValues(storeKey: string, o: OrderRow, detailSynced: boolean, at: Date): unknown[] {
  return [
    storeKey, o.code, o.guid, o.creationTime, o.changeTime, o.statusId, o.statusName, o.paid,
    o.totalWithVat, o.totalWithoutVat, o.currency, o.shippingMethod, o.paymentMethod, detailSynced, at,
  ];
}

/** Order header, customer and items in one transaction. Items are replaced as a set. */
export async function upsertOrderDetail(pool: PoolLike, storeKey: string, mapped: MappedOrderDetail, at: Date): Promise<void> {
  await withTransaction(pool, async (db) => {
    await upsertRows(db, "shoptet_orders", ORDER_COLUMNS, ["store_key", "code"], [
      orderValues(storeKey, mapped.order, true, at),
    ]);
    const c = mapped.customer;
    await upsertRows(
      db,
      "shoptet_order_customers",
      [
        "store_key", "order_code", "email", "phone",
        "billing_name", "billing_company", "billing_street", "billing_city", "billing_zip", "billing_country",
        "delivery_name", "delivery_company", "delivery_street", "delivery_city", "delivery_zip", "delivery_country",
        "synced_at",
      ],
      ["store_key", "order_code"],
      [[
        storeKey, c.orderCode, c.email, c.phone,
        c.billingName, c.billingCompany, c.billingStreet, c.billingCity, c.billingZip, c.billingCountry,
        c.deliveryName, c.deliveryCompany, c.deliveryStreet, c.deliveryCity, c.deliveryZip, c.deliveryCountry,
        at,
      ]],
    );
    await db.query("delete from shoptet_order_items where store_key = $1 and order_code = $2", [
      storeKey,
      mapped.order.code,
    ]);
    if (mapped.items.length > 0) {
      await upsertRows(
        db,
        "shoptet_order_items",
        [
          "store_key", "order_code", "item_id", "item_type", "product_guid", "code", "name", "variant_name",
          "amount", "line_total_with_vat", "line_total_without_vat", "vat_rate",
        ],
        ["store_key", "order_code", "item_id"],
        mapped.items.map((i) => [
          storeKey, i.orderCode, i.itemId, i.itemType, i.productGuid, i.code, i.name, i.variantName,
          i.amount, i.lineTotalWithVat, i.lineTotalWithoutVat, i.vatRate,
        ]),
      );
    }
  });
}

/**
 * Header refresh from the list payload when the detail fetch failed. Items and
 * customer rows are left as they are, and detail_synced is not downgraded for
 * an order whose detail was stored earlier.
 */
export async function upsertOrderHeaderOnly(db: Queryable, storeKey: string, order: OrderRow, at: Date): Promise<void> {
  const updates = ORDER_COLUMNS.filter((c) => c !== "store_key" && c !== "code" && c !== "detail_synced").map(
    (c) => `${c} = excluded.${c}`,
  );
  await db.query(
    `insert into shoptet_orders (${ORDER_COLUMNS.join(", ")})
     values (${ORDER_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (store_key, code) do update set ${updates.join(", ")}`,
    orderValues(storeKey, order, false, at),
  );
}

export async function upsertStatuses(db: Queryable, storeKey: string, statuses: readonly StatusRow[], at: Date): Promise<void> {
  if (statuses.length === 0) return;
  await upsertRows(
    db,
    "shoptet_order_statuses",
    ["store_key", "id", "name", "synced_at"],
    ["store_key", "id"],
    statuses.map((s) => [storeKey, s.id, s.name, at]),
  );
}

export async function upsertProducts(db: Queryable, storeKey: string, products: readonly ProductRow[], at: Date): Promise<void> {
  if (products.length === 0) return;
  await upsertRows(
    db,
    "shoptet_products",
    [
      "store_key", "guid", "name", "visibility", "brand", "default_category_guid", "url",
      "creation_time", "change_time", "synced_at", "deleted_at",
    ],
    ["store_key", "guid"],
    products.map((p) => [
      storeKey, p.guid, p.name, p.visibility, p.brand, p.defaultCategoryGuid, p.url,
      p.creationTime, p.changeTime, at, null,
    ]),
  );
}

export async function upsertVariants(db: Queryable, storeKey: string, variants: readonly VariantRow[], at: Date): Promise<void> {
  if (variants.length === 0) return;
  await upsertRows(
    db,
    "shoptet_product_variants",
    [
      "store_key", "code", "product_guid", "name", "ean", "price_with_vat", "action_price_with_vat", "currency",
      "stock", "availability_name", "availability_in_stock_name", "availability_sold_out_name", "visible",
      "image_url", "weight", "synced_at", "deleted_at",
    ],
    ["store_key", "code"],
    variants.map((v) => [
      storeKey, v.code, v.productGuid, v.name, v.ean, v.priceWithVat, v.actionPriceWithVat, v.currency,
      v.stock, v.availabilityName, v.availabilityInStockName, v.availabilitySoldOutName, v.visible,
      v.imageUrl, v.weight, at, null,
    ]),
  );
}

/** Marks products not returned by a complete pass as deleted. Returns how many were marked. */
export async function markMissingProductsDeleted(
  db: Queryable,
  storeKey: string,
  seenGuids: readonly string[],
  at: Date,
): Promise<number> {
  const res = await db.query(
    `update shoptet_products set deleted_at = $3
      where store_key = $1 and deleted_at is null and not (guid = any($2::text[]))`,
    [storeKey, seenGuids, at],
  );
  return res.rowCount ?? 0;
}

/**
 * Marks variants not seen in this pass as deleted, except variants of products
 * whose detail could not be fetched (their variant list is unknown).
 */
export async function markMissingVariantsDeleted(
  db: Queryable,
  storeKey: string,
  seenCodes: readonly string[],
  unknownProductGuids: readonly string[],
  at: Date,
): Promise<number> {
  const res = await db.query(
    `update shoptet_product_variants set deleted_at = $4
      where store_key = $1 and deleted_at is null
        and not (code = any($2::text[]))
        and not (product_guid = any($3::text[]))`,
    [storeKey, seenCodes, unknownProductGuids, at],
  );
  return res.rowCount ?? 0;
}

/** Replaces the category tree of a store with a complete pass. */
export async function replaceCategories(db: Queryable, storeKey: string, categories: readonly CategoryRow[], at: Date): Promise<number> {
  if (categories.length > 0) {
    await upsertRows(
      db,
      "shoptet_categories",
      ["store_key", "guid", "parent_guid", "name", "url", "visible", "synced_at"],
      ["store_key", "guid"],
      categories.map((c) => [storeKey, c.guid, c.parentGuid, c.name, c.url, c.visible, at]),
    );
  }
  const res = await db.query("delete from shoptet_categories where store_key = $1 and not (guid = any($2::text[]))", [
    storeKey,
    categories.map((c) => c.guid),
  ]);
  return res.rowCount ?? 0;
}

export interface VariantSnapshot {
  code: string;
  productGuid: string;
  name: string | null;
  visible: boolean | null;
  productVisibility: string | null;
}

/** Live (not deleted) variants of a store, with their product's visibility. */
export async function loadVariantSnapshot(db: Queryable, storeKey: string): Promise<VariantSnapshot[]> {
  const { rows } = await db.query(
    `select v.code, v.product_guid, coalesce(p.name, v.name) as name, v.visible, p.visibility
       from shoptet_product_variants v
       left join shoptet_products p on p.store_key = v.store_key and p.guid = v.product_guid
      where v.store_key = $1 and v.deleted_at is null and p.deleted_at is null`,
    [storeKey],
  );
  return rows.map((r) => ({
    code: String(r.code),
    productGuid: String(r.product_guid),
    name: (r.name as string | null) ?? null,
    visible: (r.visible as boolean | null) ?? null,
    productVisibility: (r.visibility as string | null) ?? null,
  }));
}
