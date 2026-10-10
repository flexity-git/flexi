import { describe, expect, it, vi } from "vitest";

import { createShoptetClient } from "./client.js";
import { PaginationCapError } from "./errors.js";
import type { ShoptetEvent } from "./events.js";
import { collect, paginate, type ShoptetPage } from "./pagination.js";
import { BASE_URL, FAKE_TOKEN, jsonResponse } from "./test-helpers.js";

/** A fake server that ignores itemsPerPage and always serves 10 items per page. */
function fakeOrdersServer(total: number, totalAt: (page: number) => number = () => total) {
  const orders = Array.from({ length: total }, (_, i) => ({
    code: String(1000 + i),
    fullName: "Jane Example",
    email: `jane+${i}@shop.example`,
  }));
  return vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = 10;
    const totalCount = totalAt(page);
    return jsonResponse({
      data: {
        orders: orders.slice((page - 1) * perPage, page * perPage),
        paginator: {
          totalCount,
          page,
          pageCount: Math.ceil(totalCount / perPage),
          itemsOnPage: Math.min(perPage, Math.max(totalCount - (page - 1) * perPage, 0)),
          itemsPerPage: perPage,
        },
      },
      errors: null,
    });
  });
}

describe("paginate via the client", () => {
  it("collects every item when Shoptet ignores itemsPerPage and returns 10 per page", async () => {
    const fetchMock = fakeOrdersServer(237);
    const events: ShoptetEvent[] = [];
    const client = createShoptetClient({
      token: FAKE_TOKEN,
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
    });

    const all = await collect(client.iterateOrders({ statusId: 1 }, { itemsPerPage: 100 }));

    expect(all).toHaveLength(237);
    expect(new Set(all.map((o) => o.code)).size).toBe(237);
    expect(fetchMock).toHaveBeenCalledTimes(24);
    for (const call of fetchMock.mock.calls) {
      const url = new URL(String(call[0]));
      expect(url.searchParams.get("itemsPerPage")).toBe("100");
      expect(url.searchParams.get("statusId")).toBe("1");
    }
    expect(events).toContainEqual({
      type: "items_per_page_ignored",
      context: "orders",
      requested: 100,
      honoured: 10,
    });
  });

  it("emits pagination_drift when totalCount changes between pages", async () => {
    const fetchMock = fakeOrdersServer(30, (page) => (page >= 2 ? 31 : 30));
    const events: ShoptetEvent[] = [];
    const client = createShoptetClient({
      token: FAKE_TOKEN,
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
    });

    await collect(client.iterateOrders());

    const drift = events.filter((e) => e.type === "pagination_drift");
    expect(drift).toEqual([
      { type: "pagination_drift", context: "orders", page: 2, initialTotal: 30, currentTotal: 31 },
    ]);
  });

  it("throws PaginationCapError instead of stopping silently", async () => {
    const fetchMock = fakeOrdersServer(55);
    const client = createShoptetClient({
      token: FAKE_TOKEN,
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const err = await collect(client.iterateOrders({}, { maxPages: 5 })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaginationCapError);
    expect(err).toMatchObject({ maxPages: 5, pageCount: 6, totalCount: 55, context: "orders" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("paginate (generic)", () => {
  it("stops after one page when there is no paginator", async () => {
    const fetchPage = vi.fn(async (): Promise<ShoptetPage<number>> => ({ items: [1, 2, 3] }));
    expect(await collect(paginate(fetchPage))).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("omits itemsPerPage when disabled with null", async () => {
    const fetchPage = vi.fn(async (): Promise<ShoptetPage<number>> => ({ items: [] }));
    await collect(paginate(fetchPage, { itemsPerPage: null }));
    expect(fetchPage).toHaveBeenCalledWith({ page: 1, itemsPerPage: undefined });
  });

  it("follows a pageCount that changes mid-iteration", async () => {
    const pages = [
      { items: [1], paginator: { totalCount: 2, page: 1, pageCount: 2, itemsOnPage: 1, itemsPerPage: 1 } },
      { items: [2], paginator: { totalCount: 3, page: 2, pageCount: 3, itemsOnPage: 1, itemsPerPage: 1 } },
      { items: [3], paginator: { totalCount: 3, page: 3, pageCount: 3, itemsOnPage: 1, itemsPerPage: 1 } },
    ];
    const fetchPage = vi.fn(async ({ page }: { page: number }) => pages[page - 1]!);
    expect(await collect(paginate(fetchPage, { itemsPerPage: 1 }))).toEqual([1, 2, 3]);
  });
});
