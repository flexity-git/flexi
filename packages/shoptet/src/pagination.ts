import { PaginationCapError } from "./errors.js";
import { safeEmit, type ShoptetEventHandler } from "./events.js";
import type { ShoptetPaginator } from "./types.js";

/** One page as returned by a `fetchPage` callback. */
export interface ShoptetPage<T> {
  items: T[];
  /** Missing paginator means the endpoint is not paginated: one page only. */
  paginator?: ShoptetPaginator | null;
}

export type FetchPage<T> = (args: {
  page: number;
  /** Undefined when the caller disabled `itemsPerPage` for this endpoint. */
  itemsPerPage: number | undefined;
}) => Promise<ShoptetPage<T>>;

export interface PaginateOptions {
  /**
   * Page size to request. Default 100. Pass `null` for endpoints that reject
   * the parameter. Shoptet may ignore the value; correctness does not depend on it.
   */
  itemsPerPage?: number | null;
  /** Hard limit on pages. Exceeding it throws `PaginationCapError`. Default 1000. */
  maxPages?: number;
  /** Label used in events and errors, e.g. `orders`. */
  context?: string;
  onEvent?: ShoptetEventHandler;
}

export const DEFAULT_ITEMS_PER_PAGE = 100;
export const DEFAULT_MAX_PAGES = 1000;

/**
 * Iterate every item of a paginated Shoptet list.
 *
 * - Always sends `itemsPerPage` (unless disabled) but never assumes it was honoured:
 *   the loop follows `paginator.pageCount` reported by the server.
 * - Emits `pagination_drift` when `totalCount` changes between pages, which
 *   means items may have shifted and been skipped or repeated. Use a stable
 *   filter (e.g. `changeTimeTo`) to avoid it.
 * - Throws `PaginationCapError` as soon as the server reports more pages than
 *   `maxPages`, before yielding the items of that page. It never stops silently.
 */
export async function* paginate<T>(
  fetchPage: FetchPage<T>,
  options: PaginateOptions = {},
): AsyncGenerator<T, void, undefined> {
  const itemsPerPage =
    options.itemsPerPage === null ? undefined : (options.itemsPerPage ?? DEFAULT_ITEMS_PER_PAGE);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const context = options.context ?? "list";
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError(`maxPages must be a positive integer, got ${maxPages}`);
  }

  let initialTotal: number | undefined;
  let lastTotal: number | undefined;

  for (let page = 1; ; page++) {
    const { items, paginator } = await fetchPage({ page, itemsPerPage });

    if (paginator) {
      if (page === 1) {
        initialTotal = paginator.totalCount;
        if (
          itemsPerPage !== undefined &&
          paginator.pageCount > 1 &&
          paginator.itemsPerPage !== itemsPerPage
        ) {
          safeEmit(options.onEvent, {
            type: "items_per_page_ignored",
            context,
            requested: itemsPerPage,
            honoured: paginator.itemsPerPage,
          });
        }
      } else if (initialTotal !== undefined && paginator.totalCount !== lastTotal) {
        safeEmit(options.onEvent, {
          type: "pagination_drift",
          context,
          page,
          initialTotal,
          currentTotal: paginator.totalCount,
        });
      }
      lastTotal = paginator.totalCount;

      if (paginator.pageCount > maxPages) {
        throw new PaginationCapError({
          context,
          maxPages,
          pageCount: paginator.pageCount,
          totalCount: paginator.totalCount,
        });
      }
    }

    yield* items;

    if (!paginator || page >= paginator.pageCount) return;
  }
}

/** Drain an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
