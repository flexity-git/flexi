import type { MirrorRows } from "./mapping.js";
import type { FeedRuleRow } from "./rules.js";
import type { FeedName, MirrorCategory, MirrorProduct, MirrorVariant } from "./types.js";

/** The part of pg.Pool this module uses; lets tests pass a fake. */
export interface Queryable {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export async function loadMirrorRows(db: Queryable, storeKey: string): Promise<MirrorRows> {
  const [products, variants, categories] = await Promise.all([
    db.query<MirrorProduct>(
      `select guid, name, visibility, brand, default_category_guid, url, deleted_at
         from shoptet_products where store_key = $1 and deleted_at is null`,
      [storeKey],
    ),
    db.query<MirrorVariant>(
      `select code, product_guid, name, ean, price_with_vat, action_price_with_vat, currency, stock,
              availability_name, availability_in_stock_name, visible, image_url, weight
         from shoptet_product_variants where store_key = $1 and deleted_at is null order by code`,
      [storeKey],
    ),
    db.query<MirrorCategory>(
      `select guid, parent_guid, name, url, visible from shoptet_categories where store_key = $1`,
      [storeKey],
    ),
  ]);
  return { products: products.rows, variants: variants.rows, categories: categories.rows };
}

export async function loadRuleRows(db: Queryable, feed: FeedName, storeKey: string): Promise<FeedRuleRow[]> {
  const result = await db.query<FeedRuleRow>(
    `select id, feed, store_key, "match" as match, action, "set" as set, enabled
       from feed_rules
      where enabled and feed in ($1, '*') and (store_key is null or store_key = $2)
      order by id`,
    [feed, storeKey],
  );
  return result.rows;
}

/** Item count of the last run that replaced the published file, or null. */
export async function lastWrittenCount(db: Queryable, feed: FeedName, storeKey: string): Promise<number | null> {
  const result = await db.query<{ item_count: number }>(
    `select item_count from feed_runs
      where feed = $1 and store_key = $2 and written
      order by created_at desc, id desc limit 1`,
    [feed, storeKey],
  );
  return result.rows[0]?.item_count ?? null;
}

export async function recordRun(
  db: Queryable,
  run: { feed: FeedName; storeKey: string; itemCount: number; errorCount: number; written: boolean },
): Promise<void> {
  await db.query(
    `insert into feed_runs (feed, store_key, item_count, error_count, written) values ($1, $2, $3, $4, $5)`,
    [run.feed, run.storeKey, run.itemCount, run.errorCount, run.written],
  );
}
