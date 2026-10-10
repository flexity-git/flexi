import { collect, type ShoptetClient, type ShoptetProductDetail } from "@flexity/shoptet";
import type { Logger } from "@flexity/core";
import {
  markMissingProductsDeleted,
  markMissingVariantsDeleted,
  replaceCategories,
  saveSyncState,
  upsertProducts,
  upsertVariants,
  withTransaction,
  type PoolLike,
} from "./db.js";
import {
  mapCategory,
  mapProduct,
  mapProductListItem,
  mapVariants,
  pickImageBaseUrl,
  type ProductRow,
  type VariantRow,
} from "./map.js";
import { errorMessage, mapWithConcurrency } from "./util.js";

const DETAIL_CONCURRENCY = 3;

export interface SyncProductsOptions {
  db: PoolLike;
  client: ShoptetClient;
  storeKey: string;
  now: Date;
  log: Logger;
  maxPages?: number;
}

export interface SyncProductsResult {
  store: string;
  ok: boolean;
  products: number;
  variants: number;
  detailFailures: number;
  productsMarkedDeleted: number;
  variantsMarkedDeleted: number;
  categories: number;
  categoriesRemoved: number;
  error?: string;
}

async function fetchImageBaseUrl(client: ShoptetClient, log: Logger, storeKey: string): Promise<string | null> {
  try {
    const info = await client.getEshopInfo({ include: "imageCuts" });
    return pickImageBaseUrl((info.data as Record<string, unknown> | undefined)?.imageCuts);
  } catch (err) {
    // Images are optional: everything else still syncs.
    log.warn("could not read image cuts; image_url stays empty", { store: storeKey, error: errorMessage(err) });
    return null;
  }
}

/**
 * Full pass over products, variants and categories of one store.
 * Products missing from a complete list are marked deleted_at, never removed.
 */
export async function syncProductsForStore(opts: SyncProductsOptions): Promise<SyncProductsResult> {
  const { db, client, storeKey, now, log } = opts;
  const result: SyncProductsResult = {
    store: storeKey,
    ok: false,
    products: 0,
    variants: 0,
    detailFailures: 0,
    productsMarkedDeleted: 0,
    variantsMarkedDeleted: 0,
    categories: 0,
    categoriesRemoved: 0,
  };
  const iterate = opts.maxPages !== undefined ? { maxPages: opts.maxPages } : undefined;

  try {
    // A PaginationCapError here aborts before anything is written or marked deleted.
    const listed = await collect(client.iterateProducts({}, iterate));
    const imageBaseUrl = await fetchImageBaseUrl(client, log, storeKey);

    const details = await mapWithConcurrency(listed, DETAIL_CONCURRENCY, async (item) => {
      try {
        const res = await client.getProduct(item.guid, { include: "images" });
        const detail = res.data as ShoptetProductDetail | undefined;
        if (!detail || detail.guid !== item.guid) throw new Error("detail response did not contain the product");
        return { item, detail, error: null };
      } catch (err) {
        return { item, detail: null, error: errorMessage(err) };
      }
    });

    const products: ProductRow[] = [];
    const variants: VariantRow[] = [];
    const unknownVariantGuids: string[] = [];
    for (const d of details) {
      if (d.detail) {
        products.push(mapProduct(d.detail));
        variants.push(...mapVariants(d.detail, imageBaseUrl));
      } else {
        products.push(mapProductListItem(d.item));
        unknownVariantGuids.push(d.item.guid);
        log.warn("product detail fetch failed; its variants keep their previous state", {
          store: storeKey,
          product: d.item.guid,
          error: d.error,
        });
      }
    }
    result.products = products.length;
    result.variants = variants.length;
    result.detailFailures = unknownVariantGuids.length;

    await withTransaction(db, async (tx) => {
      await upsertProducts(tx, storeKey, products, now);
      await upsertVariants(tx, storeKey, variants, now);
      // An empty list is far more likely an API problem than a store with no
      // products, so it never marks the whole catalogue deleted.
      if (listed.length > 0) {
        result.productsMarkedDeleted = await markMissingProductsDeleted(tx, storeKey, products.map((p) => p.guid), now);
        result.variantsMarkedDeleted = await markMissingVariantsDeleted(
          tx,
          storeKey,
          variants.map((v) => v.code),
          unknownVariantGuids,
          now,
        );
      } else {
        log.warn("Shoptet returned no products; nothing was marked deleted", { store: storeKey });
      }
    });

    const categories = (await client.getAllCategories(iterate)).map(mapCategory);
    result.categories = categories.length;
    if (categories.length > 0) {
      result.categoriesRemoved = await withTransaction(db, (tx) => replaceCategories(tx, storeKey, categories, now));
    }

    const error =
      unknownVariantGuids.length > 0 ? `${unknownVariantGuids.length} product detail fetch(es) failed.` : null;
    await saveSyncState(db, storeKey, "products", { ok: true, error, at: now });
    result.ok = true;
    return result;
  } catch (err) {
    result.error = errorMessage(err);
    await saveSyncState(db, storeKey, "products", { ok: false, error: result.error, at: now }).catch((saveErr) =>
      log.error("could not record products sync failure", { store: storeKey, error: errorMessage(saveErr) }),
    );
    log.error("products sync failed", { store: storeKey, error: result.error });
    return result;
  }
}
