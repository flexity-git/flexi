import { defineModule, type TaskContext } from "@flexity/core";
import type { ShoptetClient } from "@flexity/shoptet";
import { loadVariantSnapshot, requireDb, saveSyncState, upsertStatuses, type PoolLike } from "./db.js";
import { mapStatuses } from "./map.js";
import { diffStore, formatReconcileMessage, hasDifferences } from "./reconcile.js";
import { syncOrdersForStore } from "./sync-orders.js";
import { syncProductsForStore } from "./sync-products.js";
import { errorMessage, intArg, selectStores, toDate } from "./util.js";

type Ctx = TaskContext<ShoptetClient>;

function pool(ctx: Ctx): PoolLike {
  return requireDb(ctx.db);
}

/** Throws after all stores ran, so one failing store does not stop the others but the run is still marked failed. */
function failIfAny(task: string, results: readonly { store: string; ok: boolean; error?: string }[]): void {
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(`${task} failed for ${failed.map((r) => `${r.store} (${r.error ?? "unknown error"})`).join(", ")}`);
  }
}

function sinceArg(ctx: Ctx): Date | undefined {
  const raw = ctx.args.since;
  if (raw === undefined) return undefined;
  const date = typeof raw === "string" ? toDate(raw) : null;
  if (!date) throw new Error("--since must be an ISO timestamp, e.g. --since=2026-01-01T00:00:00Z.");
  return date;
}

export default defineModule<ShoptetClient>({
  name: "mirror",
  description: "Mirrors Shoptet orders, products, variants, categories and order statuses into Postgres.",
  migrationsDir: new URL("../migrations", import.meta.url),
  tasks: {
    "sync-orders": {
      description:
        "Incremental order sync by change time, with items and customer from the order detail. " +
        "Options: --store=<key>, --since=<ISO> (backfill), --max-pages=<n>.",
      async run(ctx) {
        const db = pool(ctx);
        const since = sinceArg(ctx);
        const maxPages = intArg(ctx.args, "max-pages");
        const results = [];
        for (const storeKey of selectStores(ctx.config, ctx.args)) {
          results.push(
            await syncOrdersForStore({
              db,
              client: ctx.shoptet(storeKey),
              storeKey,
              now: ctx.now(),
              log: ctx.log,
              ...(since ? { since } : {}),
              ...(maxPages !== undefined ? { maxPages } : {}),
            }),
          );
        }
        ctx.log.info("orders sync finished", { results });
        failIfAny("sync-orders", results);
        return { stores: results };
      },
    },
    "sync-products": {
      description:
        "Full pass over products, variants and categories. Products missing from the pass get deleted_at. " +
        "Options: --store=<key>, --max-pages=<n>.",
      async run(ctx) {
        const db = pool(ctx);
        const maxPages = intArg(ctx.args, "max-pages");
        const results = [];
        for (const storeKey of selectStores(ctx.config, ctx.args)) {
          results.push(
            await syncProductsForStore({
              db,
              client: ctx.shoptet(storeKey),
              storeKey,
              now: ctx.now(),
              log: ctx.log,
              ...(maxPages !== undefined ? { maxPages } : {}),
            }),
          );
        }
        ctx.log.info("products sync finished", { results });
        failIfAny("sync-products", results);
        return { stores: results };
      },
    },
    "sync-statuses": {
      description: "Copies the order status list of each store. Options: --store=<key>.",
      async run(ctx) {
        const db = pool(ctx);
        const results: { store: string; ok: boolean; statuses: number; error?: string }[] = [];
        for (const storeKey of selectStores(ctx.config, ctx.args)) {
          const now = ctx.now();
          try {
            const res = await ctx.shoptet(storeKey).getOrderStatuses();
            const statuses = mapStatuses(res.data?.statuses ?? []);
            await upsertStatuses(db, storeKey, statuses, now);
            await saveSyncState(db, storeKey, "statuses", { ok: true, error: null, at: now });
            results.push({ store: storeKey, ok: true, statuses: statuses.length });
          } catch (err) {
            const error = errorMessage(err);
            await saveSyncState(db, storeKey, "statuses", { ok: false, error, at: now }).catch(() => {});
            results.push({ store: storeKey, ok: false, statuses: 0, error });
          }
        }
        failIfAny("sync-statuses", results);
        return { stores: results };
      },
    },
    reconcile: {
      description:
        "Compares each store's variants with the primary store by code (missing codes, visibility) " +
        "and posts a short message to the products channel when they differ.",
      async run(ctx) {
        const db = pool(ctx);
        const primaryStore = ctx.config.primaryStore;
        const primary = await loadVariantSnapshot(db, primaryStore);
        if (primary.length === 0) {
          throw new Error(`Primary store "${primaryStore}" has no variants in the mirror. Run mirror:sync-products first.`);
        }
        const diffs = [];
        const skipped: string[] = [];
        for (const store of ctx.config.stores) {
          if (store.key === primaryStore) continue;
          const variants = await loadVariantSnapshot(db, store.key);
          if (variants.length === 0) {
            // Never synced: reporting the whole catalogue as missing would be noise.
            skipped.push(store.key);
            continue;
          }
          diffs.push(diffStore(store.key, primary, variants));
        }
        const message = formatReconcileMessage(primaryStore, diffs);
        const notified = message ? (await ctx.notify("products", message)).delivered : false;
        return {
          primaryStore,
          skippedWithoutData: skipped,
          notified,
          stores: diffs.map((d) => ({
            store: d.store,
            differs: hasDifferences(d),
            missing: d.missing.length,
            extra: d.extra.length,
            visibility: d.visibility.length,
            missingSample: d.missing.slice(0, 20),
            extraSample: d.extra.slice(0, 20),
            visibilitySample: d.visibility.slice(0, 20),
          })),
        };
      },
    },
  },
  tables: [
    {
      name: "shoptet_orders",
      scope: "data:read",
      description:
        "Order headers per store (store_key, code): status_id/status_name, paid, totals with and without VAT, currency, " +
        "shipping and payment method, creation and change time. No personal data. detail_synced=false means items and " +
        "customer are not stored yet for this order.",
    },
    {
      name: "shoptet_order_customers",
      scope: "data:read:customers",
      description:
        "Personal data of each order: email, phone, billing and delivery name, company, street, city, zip, country. " +
        "Join on (store_key, order_code) = shoptet_orders (store_key, code).",
    },
    {
      name: "shoptet_order_items",
      scope: "data:read",
      description:
        "Order lines: item_type, product_guid, code (variant code), name, amount, vat_rate. line_total_with_vat and " +
        "line_total_without_vat are ROW totals for the whole amount, never unit prices: do not multiply them by amount.",
    },
    {
      name: "shoptet_order_statuses",
      scope: "data:read",
      description: "Order status names per store (store_key, id). Join shoptet_orders.status_id.",
    },
    {
      name: "shoptet_products",
      scope: "data:read",
      description:
        "Products per store (store_key, guid): name, visibility, brand, default_category_guid, url. deleted_at is set " +
        "when the product disappeared from Shoptet; filter deleted_at is null for live products.",
    },
    {
      name: "shoptet_product_variants",
      scope: "data:read",
      description:
        "Variants (sellable codes) per store (store_key, code): product_guid, name, ean, price_with_vat, " +
        "action_price_with_vat, currency, stock, visible, image_url, weight. availability_name is the availability for " +
        "the current stock; availability_in_stock_name and availability_sold_out_name are the two configured values. " +
        "Filter deleted_at is null for live variants.",
    },
    {
      name: "shoptet_categories",
      scope: "data:read",
      description: "Category tree per store (store_key, guid): parent_guid, name, url, visible.",
    },
    {
      name: "shoptet_sync_state",
      scope: "data:read",
      description:
        "Sync bookkeeping per store and resource (orders, products, statuses): cursor, last_success_at, last_error. " +
        "Use it to judge how fresh the mirror is.",
    },
  ],
});
