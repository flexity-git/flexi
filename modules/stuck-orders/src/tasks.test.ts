import { createLogger, type FlexiConfig, type TaskArgs, type TaskContext } from "@flexity/core";
import { describe, expect, it, vi } from "vitest";
import stuckOrders from "./index.js";
import { parseOptions } from "./tasks.js";

// 2026-10-08 is a Thursday. Europe/Prague is UTC+2 in October.
const NOW = new Date("2026-10-08T10:00:00Z");

interface FakeState {
  sync: { store_key: string; last_success_at: Date | null }[];
  rules: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
}

/** Routes each query by its text to synthetic rows and records every call. */
function fakeDb(state: FakeState) {
  const calls: { text: string; values: unknown[] }[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("from shoptet_sync_state")) return { rows: state.sync };
    if (text.includes("from stuck_order_rules")) return { rows: state.rules };
    if (text.includes("from shoptet_orders")) return { rows: state.orders };
    if (text.includes("from stuck_order_alerts")) return { rows: state.alerts };
    return { rows: [] };
  });
  return { db: { query }, calls };
}

const config: FlexiConfig = {
  stores: [
    { key: "aa", token: "test-token-aa" },
    { key: "bb", token: "test-token-bb" },
  ],
  primaryStore: "aa",
  slack: { orders: "https://hooks.example/orders", alerts: "https://hooks.example/alerts" },
  timezone: "Europe/Prague",
  modules: null,
};

function ctxFor(db: { query: unknown }, args: TaskArgs = {}, delivered = true) {
  const notify = vi.fn(async (_channel: string, _text: string) => ({ delivered }));
  const ctx = {
    config,
    db,
    shoptet: () => {
      throw new Error("not used");
    },
    notify,
    log: createLogger({}, { write: () => {} }),
    now: () => NOW,
    args,
  } as unknown as TaskContext;
  return { ctx, notify };
}

const freshSync = [
  { store_key: "aa", last_success_at: new Date("2026-10-08T09:30:00Z") },
  { store_key: "bb", last_success_at: new Date("2026-10-08T09:45:00Z") },
];
const staleSync = [
  { store_key: "aa", last_success_at: new Date("2026-10-08T05:00:00Z") },
  { store_key: "bb", last_success_at: new Date("2026-10-08T04:00:00Z") },
];
const ruleRow = {
  id: "1",
  store_key: null,
  status_id: null,
  status_name: "Processing",
  max_business_hours: "24",
  channel: "orders",
  note: "example",
};
function orderRow(code: string, store = "aa", changed = "2026-10-05T08:00:00Z") {
  return {
    store_key: store,
    code,
    status_id: 101,
    status_name: "Processing",
    creation_time: new Date("2026-10-01T08:00:00Z"),
    change_time: new Date(changed),
  };
}

const check = stuckOrders.tasks.check!;
const report = stuckOrders.tasks.report!;

describe("stuck-orders:check", () => {
  it("sends ONE stale-mirror message and checks nothing when every store is stale", async () => {
    const { db, calls } = fakeDb({ sync: staleSync, rules: [ruleRow], orders: [orderRow("T1"), orderRow("T2")], alerts: [] });
    const { ctx, notify } = ctxFor(db);
    const summary = await check.run(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe("alerts");
    expect(String(notify.mock.calls[0]![1])).toContain("Order mirror is stale");
    expect(calls.some((c) => c.text.includes("from shoptet_orders"))).toBe(false);
    expect(calls.some((c) => c.text.includes("insert into stuck_order_alerts"))).toBe(false);
    expect(summary).toMatchObject({ checkedStores: [], stuck: 0, due: 0, alerted: 0, staleNotified: true });
  });

  it("skips only the stale store and checks the fresh one", async () => {
    const sync = [freshSync[0]!, staleSync[1]!];
    const { db, calls } = fakeDb({ sync, rules: [ruleRow], orders: [orderRow("T1")], alerts: [] });
    const { ctx, notify } = ctxFor(db);
    const summary = await check.run(ctx);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(["alerts", "orders"]);
    const orderQuery = calls.find((c) => c.text.includes("from shoptet_orders"))!;
    expect(orderQuery.values[0]).toEqual(["aa"]);
    expect(summary).toMatchObject({ checkedStores: ["aa"], alerted: 1 });
  });

  it("groups due orders into one message per channel and records them", async () => {
    const { db, calls } = fakeDb({
      sync: freshSync,
      rules: [ruleRow],
      orders: [orderRow("T1"), orderRow("T2", "bb"), orderRow("T3", "aa", "2026-10-08T08:00:00Z")],
      alerts: [],
    });
    const { ctx, notify } = ctxFor(db);
    const summary = await check.run(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [channel, text] = notify.mock.calls[0]!;
    expect(channel).toBe("orders");
    expect(text).toContain("2 orders have been in a status");
    expect(text).toContain("aa T1: Processing");
    expect(text).toContain("bb T2: Processing");
    expect(text).not.toContain("T3");
    const insert = calls.find((c) => c.text.includes("insert into stuck_order_alerts"))!;
    expect(insert.values.slice(0, 3)).toEqual([["aa", "bb"], ["T1", "T2"], [1, 1]]);
    expect(summary).toMatchObject({ stuck: 2, due: 2, alerted: 2, resolved: 0 });
  });

  it("does not re-alert inside the cooldown", async () => {
    const openAlert = {
      id: "9",
      store_key: "aa",
      order_code: "T1",
      rule_id: "1",
      first_alerted_at: new Date("2026-10-08T06:00:00Z"),
      last_alerted_at: new Date("2026-10-08T06:00:00Z"),
      alert_count: 1,
    };
    const { db } = fakeDb({ sync: freshSync, rules: [ruleRow], orders: [orderRow("T1")], alerts: [openAlert] });
    const { ctx, notify } = ctxFor(db);
    expect(await check.run(ctx)).toMatchObject({ stuck: 1, due: 0, alerted: 0 });
    expect(notify).not.toHaveBeenCalled();

    const { ctx: shortCooldown, notify: notify2 } = ctxFor(db, { "cooldown-hours": "2" });
    expect(await check.run(shortCooldown)).toMatchObject({ due: 1, alerted: 1 });
    expect(String(notify2.mock.calls[0]![1])).toContain("(reminder)");
  });

  it("resolves open alerts whose order left the status", async () => {
    const openAlert = {
      id: "9",
      store_key: "bb",
      order_code: "T9",
      rule_id: "1",
      first_alerted_at: new Date("2026-10-07T06:00:00Z"),
      last_alerted_at: new Date("2026-10-07T06:00:00Z"),
      alert_count: 1,
    };
    const { db, calls } = fakeDb({ sync: freshSync, rules: [ruleRow], orders: [], alerts: [openAlert] });
    const { ctx, notify } = ctxFor(db);
    expect(await check.run(ctx)).toMatchObject({ resolved: 1 });
    expect(notify).not.toHaveBeenCalled();
    const update = calls.find((c) => c.text.includes("update stuck_order_alerts"))!;
    expect(update.values).toEqual([[9], NOW]);
  });

  it("does not record alerts when Slack did not accept the message", async () => {
    const { db, calls } = fakeDb({ sync: freshSync, rules: [ruleRow], orders: [orderRow("T1")], alerts: [] });
    const { ctx } = ctxFor(db, {}, false);
    expect(await check.run(ctx)).toMatchObject({ due: 1, alerted: 0 });
    expect(calls.some((c) => c.text.includes("insert into stuck_order_alerts"))).toBe(false);
  });

  it("--dry-run returns the messages and neither notifies nor writes", async () => {
    const openAlert = {
      id: "9",
      store_key: "bb",
      order_code: "T9",
      rule_id: "1",
      first_alerted_at: NOW,
      last_alerted_at: NOW,
      alert_count: 1,
    };
    const { db, calls } = fakeDb({ sync: freshSync, rules: [ruleRow], orders: [orderRow("T1")], alerts: [openAlert] });
    const { ctx, notify } = ctxFor(db, { "dry-run": true });
    const summary = await check.run(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(calls.some((c) => /^\s*(insert|update)/.test(c.text))).toBe(false);
    expect(summary).toMatchObject({ dryRun: true, due: 1, alerted: 0, resolved: 1 });
    expect((summary as { messages: { channel: string; text: string }[] }).messages[0]!.text).toContain("aa T1");
  });

  it("fails clearly without a database", async () => {
    const { ctx } = ctxFor(null as unknown as { query: unknown });
    await expect(check.run(ctx)).rejects.toThrow(/FLEXI_DATABASE_URL/);
  });
});

describe("stuck-orders:report", () => {
  it("counts stuck orders per store and status without notifying or writing", async () => {
    const { db, calls } = fakeDb({
      sync: freshSync,
      rules: [ruleRow],
      orders: [orderRow("T1"), orderRow("T2"), orderRow("T3", "bb")],
      alerts: [],
    });
    const { ctx, notify } = ctxFor(db);
    const summary = await report.run(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(calls.some((c) => /^\s*(insert|update)/.test(c.text))).toBe(false);
    expect(summary).toMatchObject({
      total: 3,
      stuck: [
        { storeKey: "aa", status: "Processing", count: 2 },
        { storeKey: "bb", status: "Processing", count: 1 },
      ],
    });
  });
});

describe("parseOptions", () => {
  it("applies defaults", () => {
    expect(parseOptions({})).toEqual({
      dryRun: false,
      cooldownHours: 24,
      maxMirrorAgeHours: 3,
      lookbackDays: 30,
      maxLines: 20,
      holidays: [],
    });
  });
  it("rejects bad values", () => {
    expect(() => parseOptions({ "cooldown-hours": "-1" })).toThrow(/cooldown-hours/);
    expect(() => parseOptions({ "cooldown-hours": true })).toThrow(/cooldown-hours/);
    expect(() => parseOptions({ holidays: "2026-13" })).toThrow(/holidays/);
  });
  it("parses holidays", () => {
    expect(parseOptions({ holidays: "2026-12-24, 2026-12-25" }).holidays).toEqual(["2026-12-24", "2026-12-25"]);
  });
});
