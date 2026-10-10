import { collect, toShoptetTimestamp, type ShoptetClient, type ShoptetOrderListItem, type ShoptetOrdersParams } from "@flexity/shoptet";
import type { Logger } from "@flexity/core";
import { getSyncState, saveSyncState, upsertOrderDetail, upsertOrderHeaderOnly, type PoolLike } from "./db.js";
import { mapOrderDetail, mapOrderHeader } from "./map.js";
import { errorMessage, mapWithConcurrency, toDate } from "./util.js";

/** Detail requests in flight per store. The client also caps at Shoptet's limit. */
const DETAIL_CONCURRENCY = 3;

export interface NextCursorInput {
  /** Cursor stored before this run. */
  current: Date | null;
  /** Lower bound this run fetched from (`--since` or the stored cursor). null = from the beginning. */
  from: Date | null;
  /** Change times of orders whose detail was stored. */
  succeeded: readonly (Date | null)[];
  /** Change times of orders whose detail fetch failed. null = unknown time. */
  failed: readonly (Date | null)[];
}

/**
 * Where the orders cursor may move after a run. Returns undefined when it must stay.
 *
 * - Never past a failed detail fetch: only change times strictly before the
 *   earliest failure count, so the failed order is fetched again next run.
 * - A failure with an unknown change time blocks any move.
 * - Never backwards.
 * - A `--since` later than the stored cursor leaves a gap that was not fetched,
 *   so the cursor stays.
 */
export function computeNextCursor(input: NextCursorInput): Date | undefined {
  const { current, from } = input;
  if (current !== null && from !== null && from.getTime() > current.getTime()) return undefined;
  if (input.failed.some((t) => t === null)) return undefined;

  const failedTimes = input.failed.map((t) => (t as Date).getTime());
  const limit = failedTimes.length > 0 ? Math.min(...failedTimes) : Infinity;
  let best: number | null = null;
  for (const t of input.succeeded) {
    if (t === null) continue;
    const ms = t.getTime();
    if (ms < limit && (best === null || ms > best)) best = ms;
  }
  if (best === null) return undefined;
  if (current !== null && best <= current.getTime()) return undefined;
  return new Date(best);
}

export interface SyncOrdersOptions {
  db: PoolLike;
  client: ShoptetClient;
  storeKey: string;
  now: Date;
  log: Logger;
  /** Backfill lower bound. Overrides the stored cursor for this run. */
  since?: Date;
  maxPages?: number;
}

export interface SyncOrdersResult {
  store: string;
  ok: boolean;
  listed: number;
  detailsStored: number;
  detailFailures: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  error?: string;
}

function orderTime(order: ShoptetOrderListItem): Date | null {
  return toDate(order.changeTime) ?? toDate(order.creationTime);
}

export async function syncOrdersForStore(opts: SyncOrdersOptions): Promise<SyncOrdersResult> {
  const { db, client, storeKey, now, log } = opts;
  const state = await getSyncState(db, storeKey, "orders");
  const from = opts.since ?? state.cursor;
  const result: SyncOrdersResult = {
    store: storeKey,
    ok: false,
    listed: 0,
    detailsStored: 0,
    detailFailures: 0,
    cursorBefore: state.cursor?.toISOString() ?? null,
    cursorAfter: state.cursor?.toISOString() ?? null,
  };

  try {
    // changeTimeTo pins the window, so orders changing during the run do not
    // shift pages under us; they are picked up by the next run.
    const params: ShoptetOrdersParams = { changeTimeTo: toShoptetTimestamp(now) };
    if (from) params.changeTimeFrom = toShoptetTimestamp(from);
    const listed = await collect(
      client.iterateOrders(params, opts.maxPages !== undefined ? { maxPages: opts.maxPages } : undefined),
    );
    result.listed = listed.length;

    const details = await mapWithConcurrency(listed, DETAIL_CONCURRENCY, async (item) => {
      try {
        const res = await client.getOrder(item.code);
        const order = res.data?.order;
        if (!order || order.code !== item.code) throw new Error("detail response did not contain the order");
        return { item, order, error: null };
      } catch (err) {
        return { item, order: null, error: errorMessage(err) };
      }
    });

    const succeeded: (Date | null)[] = [];
    const failed: (Date | null)[] = [];
    for (const d of details) {
      if (d.order) {
        await upsertOrderDetail(db, storeKey, mapOrderDetail(d.order), now);
        succeeded.push(orderTime(d.item));
      } else {
        // Keep status and totals fresh even without the detail; items and the
        // customer row wait for the retry.
        await upsertOrderHeaderOnly(db, storeKey, mapOrderHeader(d.item), now);
        failed.push(orderTime(d.item));
        log.warn("order detail fetch failed; cursor will not pass this order", {
          store: storeKey,
          order: d.item.code,
          error: d.error,
        });
      }
    }
    result.detailsStored = succeeded.length;
    result.detailFailures = failed.length;

    const next = computeNextCursor({ current: state.cursor, from, succeeded, failed });
    const error =
      failed.length > 0 ? `${failed.length} order detail fetch(es) failed; cursor held before the earliest failure.` : null;
    await saveSyncState(db, storeKey, "orders", { cursor: next, ok: true, error, at: now });
    result.ok = true;
    result.cursorAfter = (next ?? state.cursor)?.toISOString() ?? null;
    return result;
  } catch (err) {
    // Includes PaginationCapError: the list is incomplete, so the cursor stays.
    result.error = errorMessage(err);
    await saveSyncState(db, storeKey, "orders", { ok: false, error: result.error, at: now }).catch((saveErr) =>
      log.error("could not record orders sync failure", { store: storeKey, error: errorMessage(saveErr) }),
    );
    log.error("orders sync failed", { store: storeKey, error: result.error });
    return result;
  }
}
