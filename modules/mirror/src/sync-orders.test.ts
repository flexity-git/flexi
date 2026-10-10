import { describe, expect, it } from "vitest";
import { PaginationCapError, type ShoptetClient, type ShoptetOrderListItem } from "@flexity/shoptet";
import { computeNextCursor, syncOrdersForStore } from "./sync-orders.js";
import { createFakePool, lastSyncStateWrite, silentLog } from "./test-helpers.js";

const t = (iso: string) => new Date(iso);
const NOW = t("2026-03-10T12:00:00Z");
const STORED_CURSOR = t("2026-03-01T00:00:00Z");

function listItem(code: string, changeTime: string): ShoptetOrderListItem {
  return { code, changeTime, creationTime: changeTime, status: { id: 1, name: "New" }, price: { withVat: "10" } };
}

function fakeClient(opts: {
  orders?: ShoptetOrderListItem[];
  failDetailFor?: string[];
  listError?: Error;
  seenParams?: Record<string, unknown>[];
}): ShoptetClient {
  return {
    async *iterateOrders(params: Record<string, unknown>) {
      opts.seenParams?.push(params);
      if (opts.listError) throw opts.listError;
      yield* opts.orders ?? [];
    },
    async getOrder(code: string) {
      if (opts.failDetailFor?.includes(code)) throw new Error("HTTP 500");
      const item = (opts.orders ?? []).find((o) => o.code === code)!;
      return { data: { order: { ...item, email: "jane@shop.example", items: [] } } };
    },
  } as unknown as ShoptetClient;
}

describe("computeNextCursor", () => {
  it("advances to the newest change time when every detail succeeded", () => {
    expect(
      computeNextCursor({
        current: STORED_CURSOR,
        from: STORED_CURSOR,
        succeeded: [t("2026-03-02T00:00:00Z"), t("2026-03-05T00:00:00Z")],
        failed: [],
      }),
    ).toEqual(t("2026-03-05T00:00:00Z"));
  });

  it("stops strictly before the earliest failed detail", () => {
    expect(
      computeNextCursor({
        current: STORED_CURSOR,
        from: STORED_CURSOR,
        succeeded: [t("2026-03-02T00:00:00Z"), t("2026-03-03T00:00:00Z"), t("2026-03-05T00:00:00Z")],
        failed: [t("2026-03-03T00:00:00Z")],
      }),
    ).toEqual(t("2026-03-02T00:00:00Z"));
  });

  it("does not move when the earliest failure is the first order", () => {
    expect(
      computeNextCursor({
        current: STORED_CURSOR,
        from: STORED_CURSOR,
        succeeded: [t("2026-03-05T00:00:00Z")],
        failed: [t("2026-03-02T00:00:00Z")],
      }),
    ).toBeUndefined();
  });

  it("does not move when a failed order has no known time", () => {
    expect(
      computeNextCursor({ current: null, from: null, succeeded: [t("2026-03-05T00:00:00Z")], failed: [null] }),
    ).toBeUndefined();
  });

  it("never moves backwards", () => {
    expect(
      computeNextCursor({
        current: STORED_CURSOR,
        from: t("2026-01-01T00:00:00Z"),
        succeeded: [t("2026-02-01T00:00:00Z")],
        failed: [],
      }),
    ).toBeUndefined();
  });

  it("does not jump over a gap when --since is later than the stored cursor", () => {
    expect(
      computeNextCursor({
        current: STORED_CURSOR,
        from: t("2026-03-04T00:00:00Z"),
        succeeded: [t("2026-03-05T00:00:00Z")],
        failed: [],
      }),
    ).toBeUndefined();
  });

  it("compares instants, not strings with different offsets", () => {
    expect(
      computeNextCursor({
        current: null,
        from: null,
        succeeded: [new Date("2026-03-05T10:00:00+02:00"), new Date("2026-03-05T09:30:00+01:00")],
        failed: [],
      }),
    ).toEqual(new Date("2026-03-05T08:30:00Z"));
  });
});

describe("syncOrdersForStore", () => {
  const stored = { cursor: STORED_CURSOR, last_success_at: null, last_error: null };

  it("stores details, refreshes failed headers and holds the cursor before the failure", async () => {
    const { pool, queries } = createFakePool({ syncState: stored });
    const orders = [
      listItem("A1", "2026-03-02T10:00:00+0100"),
      listItem("A2", "2026-03-03T10:00:00+0100"),
      listItem("A3", "2026-03-04T10:00:00+0100"),
    ];
    const seenParams: Record<string, unknown>[] = [];
    const result = await syncOrdersForStore({
      db: pool,
      client: fakeClient({ orders, failDetailFor: ["A2"], seenParams }),
      storeKey: "sk",
      now: NOW,
      log: silentLog,
    });

    expect(seenParams[0]).toEqual({
      changeTimeFrom: "2026-03-01T01:00:00+0100",
      changeTimeTo: "2026-03-10T13:00:00+0100",
    });
    expect(result).toMatchObject({ ok: true, listed: 3, detailsStored: 2, detailFailures: 1 });
    expect(result.cursorAfter).toBe("2026-03-02T09:00:00.000Z");

    const write = lastSyncStateWrite(queries);
    expect(write).toMatchObject({ storeKey: "sk", resource: "orders", ok: true, cursorProvided: true });
    expect(write?.cursor).toEqual(t("2026-03-02T09:00:00Z"));
    expect(String(write?.error)).toContain("1 order detail");

    // A2 got a header-only upsert: no customer row, no item delete for it.
    const customerWrites = queries.filter((q) => /insert into shoptet_order_customers/.test(q.text));
    expect(customerWrites.map((q) => q.params[1])).toEqual(["A1", "A3"]);
    const headerOnly = queries.find((q) => /insert into shoptet_orders/.test(q.text) && q.params[1] === "A2");
    expect(headerOnly?.text).not.toMatch(/detail_synced = excluded/);
  });

  it("leaves the cursor untouched when pagination hits the cap", async () => {
    const { pool, queries } = createFakePool({ syncState: stored });
    const result = await syncOrdersForStore({
      db: pool,
      client: fakeClient({
        listError: new PaginationCapError({ context: "orders", maxPages: 1000, pageCount: 1500, totalCount: 150000 }),
      }),
      storeKey: "sk",
      now: NOW,
      log: silentLog,
    });

    expect(result.ok).toBe(false);
    expect(result.cursorAfter).toBe(STORED_CURSOR.toISOString());
    expect(queries.some((q) => /insert into shoptet_orders/.test(q.text))).toBe(false);
    const write = lastSyncStateWrite(queries);
    expect(write).toMatchObject({ ok: false, cursorProvided: false, cursor: null });
    expect(String(write?.error)).toMatch(/1500/);
  });

  it("does not move the cursor when the database write fails", async () => {
    const { pool, queries } = createFakePool({ syncState: stored, failOn: /insert into shoptet_order_items|delete from shoptet_order_items/ });
    const result = await syncOrdersForStore({
      db: pool,
      client: fakeClient({ orders: [listItem("A1", "2026-03-02T10:00:00+0100")] }),
      storeKey: "sk",
      now: NOW,
      log: silentLog,
    });
    expect(result.ok).toBe(false);
    expect(queries.some((q) => q.text === "rollback")).toBe(true);
    expect(lastSyncStateWrite(queries)).toMatchObject({ ok: false, cursorProvided: false });
  });

  it("uses --since for a backfill and fetches everything without a cursor", async () => {
    const { pool } = createFakePool({ syncState: null });
    const seenParams: Record<string, unknown>[] = [];
    await syncOrdersForStore({
      db: pool,
      client: fakeClient({ orders: [], seenParams }),
      storeKey: "sk",
      now: NOW,
      log: silentLog,
    });
    expect(seenParams[0]).not.toHaveProperty("changeTimeFrom");

    await syncOrdersForStore({
      db: pool,
      client: fakeClient({ orders: [], seenParams }),
      storeKey: "sk",
      now: NOW,
      log: silentLog,
      since: t("2025-01-01T00:00:00Z"),
    });
    expect(seenParams[1]).toMatchObject({ changeTimeFrom: "2025-01-01T01:00:00+0100" });
  });
});
