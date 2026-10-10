import { describe, expect, it } from "vitest";
import {
  buildStaleMessage,
  buildStuckMessage,
  countStuck,
  evaluate,
  findStaleStores,
  groupByChannel,
  ruleMatchesOrder,
  type EvaluateInput,
  type MirrorOrder,
  type OpenAlert,
  type StuckRule,
} from "./evaluate.js";

// October 2026 in Europe/Prague is UTC+2. 2026-10-09 is a Friday, 2026-10-12 a Monday.
const TZ = { timeZone: "Europe/Prague" };
const at = (iso: string) => new Date(iso);

function rule(over: Partial<StuckRule> = {}): StuckRule {
  return {
    id: 1,
    storeKey: null,
    statusId: null,
    statusName: "Processing",
    maxBusinessHours: 24,
    channel: "orders",
    note: null,
    ...over,
  };
}

function order(over: Partial<MirrorOrder> = {}): MirrorOrder {
  return {
    storeKey: "aa",
    code: "T0001",
    statusId: 101,
    statusName: "Processing",
    creationTime: at("2026-10-01T08:00:00Z"),
    changeTime: at("2026-10-06T10:00:00Z"),
    ...over,
  };
}

function alert(over: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: 7,
    storeKey: "aa",
    orderCode: "T0001",
    ruleId: 1,
    firstAlertedAt: at("2026-10-08T10:00:00Z"),
    lastAlertedAt: at("2026-10-08T10:00:00Z"),
    alertCount: 1,
    ...over,
  };
}

function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    rules: [rule()],
    orders: [order()],
    openAlerts: [],
    now: at("2026-10-08T10:00:00Z"),
    businessHours: TZ,
    cooldownHours: 24,
    checkedStores: ["aa", "bb"],
    ...over,
  };
}

describe("ruleMatchesOrder", () => {
  it("matches by status name, case-insensitive and trimmed", () => {
    expect(ruleMatchesOrder(rule({ statusName: "  processing " }), order())).toBe(true);
  });
  it("matches by status id", () => {
    expect(ruleMatchesOrder(rule({ statusName: null, statusId: 101 }), order({ statusName: null }))).toBe(true);
  });
  it("matches either id or name when both are set", () => {
    const r = rule({ statusId: 999, statusName: "Processing" });
    expect(ruleMatchesOrder(r, order({ statusId: 101 }))).toBe(true);
    expect(ruleMatchesOrder(r, order({ statusId: 999, statusName: "Other" }))).toBe(true);
    expect(ruleMatchesOrder(r, order({ statusId: 5, statusName: "Other" }))).toBe(false);
  });
  it("respects store_key, null means all stores", () => {
    expect(ruleMatchesOrder(rule({ storeKey: "bb" }), order({ storeKey: "aa" }))).toBe(false);
    expect(ruleMatchesOrder(rule({ storeKey: "aa" }), order({ storeKey: "aa" }))).toBe(true);
    expect(ruleMatchesOrder(rule({ storeKey: null }), order({ storeKey: "bb" }))).toBe(true);
  });
});

describe("evaluate: business-hour thresholds", () => {
  it("counts a working-day span in full", () => {
    // Tue 12:00 to Wed 12:00 local = 24 business hours, not over a 24 h limit.
    const base = input({ orders: [order({ changeTime: at("2026-10-06T10:00:00Z") })], now: at("2026-10-07T10:00:00Z") });
    expect(evaluate(base).stuck).toHaveLength(0);
    const later = evaluate({ ...base, now: at("2026-10-07T10:30:00Z") });
    expect(later.stuck).toHaveLength(1);
    expect(later.stuck[0]!.ageBusinessHours).toBeCloseTo(24.5);
  });

  it("does not count the weekend", () => {
    // Fri 12:00 to Mon 12:00 local: 72 wall-clock hours, 24 business hours.
    const weekend = input({
      orders: [order({ changeTime: at("2026-10-09T10:00:00Z") })],
      now: at("2026-10-12T10:00:00Z"),
    });
    expect(evaluate(weekend).stuck).toHaveLength(0);
    const tighter = evaluate({ ...weekend, rules: [rule({ maxBusinessHours: 20 })] });
    expect(tighter.stuck).toHaveLength(1);
    expect(tighter.stuck[0]!.ageBusinessHours).toBeCloseTo(24);
  });

  it("does not count holidays", () => {
    const r = evaluate(
      input({
        rules: [rule({ maxBusinessHours: 20 })],
        orders: [order({ changeTime: at("2026-10-09T10:00:00Z") })],
        now: at("2026-10-12T10:00:00Z"),
        businessHours: { ...TZ, holidays: ["2026-10-12"] },
      }),
    );
    expect(r.stuck).toHaveLength(0);
  });

  it("ignores orders of stores that were not checked", () => {
    const r = evaluate(input({ orders: [order({ storeKey: "cc" })] }));
    expect(r.stuck).toHaveLength(0);
  });
});

describe("evaluate: dedup and cooldown", () => {
  const stuckNow = at("2026-10-08T10:00:00Z"); // order changed Tue 12:00 local, 48 business h before

  it("announces a stuck order with no open alert", () => {
    const r = evaluate(input({ now: stuckNow }));
    expect(r.due).toHaveLength(1);
    expect(r.due[0]!.openAlert).toBeNull();
  });

  it("does not re-announce inside the cooldown, but still reports it as stuck", () => {
    const r = evaluate(input({ now: stuckNow, openAlerts: [alert({ lastAlertedAt: at("2026-10-08T08:00:00Z") })] }));
    expect(r.stuck).toHaveLength(1);
    expect(r.due).toHaveLength(0);
    expect(r.resolve).toHaveLength(0);
  });

  it("re-announces as a reminder once the cooldown has passed", () => {
    const r = evaluate(input({ now: stuckNow, openAlerts: [alert({ lastAlertedAt: at("2026-10-07T09:00:00Z") })] }));
    expect(r.due).toHaveLength(1);
    expect(r.due[0]!.openAlert?.id).toBe(7);
  });

  it("honours a custom cooldown", () => {
    const openAlerts = [alert({ lastAlertedAt: at("2026-10-08T05:00:00Z") })];
    expect(evaluate(input({ now: stuckNow, openAlerts, cooldownHours: 6 })).due).toHaveLength(0);
    expect(evaluate(input({ now: stuckNow, openAlerts, cooldownHours: 4 })).due).toHaveLength(1);
  });

  it("tracks the same order separately per rule", () => {
    const rules = [rule({ id: 1 }), rule({ id: 2, statusName: null, statusId: 101, channel: "alerts" })];
    const r = evaluate(input({ now: stuckNow, rules, openAlerts: [alert({ ruleId: 1, lastAlertedAt: stuckNow })] }));
    expect(r.due.map((h) => h.rule.id)).toEqual([2]);
  });
});

describe("evaluate: resolution", () => {
  it("resolves an open alert when the order left the status", () => {
    const r = evaluate(input({ orders: [order({ statusId: 200, statusName: "Shipped" })], openAlerts: [alert()] }));
    expect(r.resolve.map((a) => a.id)).toEqual([7]);
  });

  it("resolves an open alert when the order is no longer in the candidate list", () => {
    const r = evaluate(input({ orders: [], openAlerts: [alert()] }));
    expect(r.resolve).toHaveLength(1);
  });

  it("keeps an alert open while the order sits in the status, even under the threshold", () => {
    const r = evaluate(input({ orders: [order({ changeTime: at("2026-10-08T09:00:00Z") })], openAlerts: [alert()] }));
    expect(r.stuck).toHaveLength(0);
    expect(r.resolve).toHaveLength(0);
  });

  it("never resolves alerts of a store that was not checked", () => {
    const r = evaluate(input({ orders: [], openAlerts: [alert({ storeKey: "cc" })] }));
    expect(r.resolve).toHaveLength(0);
  });
});

describe("findStaleStores", () => {
  const now = at("2026-10-12T05:00:00Z");
  it("flags missing and old sync state, keeps fresh stores", () => {
    const stale = findStaleStores(
      ["aa", "bb", "cc"],
      [
        { storeKey: "aa", lastSuccessAt: at("2026-10-12T04:30:00Z") },
        { storeKey: "bb", lastSuccessAt: at("2026-10-12T01:00:00Z") },
      ],
      now,
      3,
    );
    expect(stale).toEqual([
      { storeKey: "bb", lastSuccessAt: at("2026-10-12T01:00:00Z") },
      { storeKey: "cc", lastSuccessAt: null },
    ]);
  });
  it("treats a null last_success_at as stale", () => {
    expect(findStaleStores(["aa"], [{ storeKey: "aa", lastSuccessAt: null }], now, 3)).toHaveLength(1);
  });
});

describe("messages", () => {
  it("caps the list with +N more", () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      rule: rule(),
      order: order({ code: `T000${i}` }),
      ageBusinessHours: 30 + i,
      openAlert: null,
    }));
    const text = buildStuckMessage(hits, 3);
    expect(text).toContain("5 orders have been in a status");
    expect(text).toContain("• aa T0000: Processing, 30.0 business h (limit 24)");
    expect(text.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(3);
    expect(text).toContain("+2 more");
    expect(text).not.toContain("\u2014");
  });

  it("marks reminders", () => {
    const text = buildStuckMessage([{ rule: rule(), order: order(), ageBusinessHours: 50, openAlert: alert() }], 10);
    expect(text).toContain("(reminder)");
  });

  it("describes stale stores in one message", () => {
    const text = buildStaleMessage(
      [
        { storeKey: "aa", lastSuccessAt: at("2026-10-12T00:00:00Z") },
        { storeKey: "bb", lastSuccessAt: null },
      ],
      at("2026-10-12T05:00:00Z"),
      3,
      true,
    );
    expect(text).toContain("Order mirror is stale");
    expect(text).toContain("aa: last successful orders sync 2026-10-12T00:00:00.000Z (5.0 h ago)");
    expect(text).toContain("bb: no successful orders sync recorded");
  });

  it("groups by channel and counts each order once", () => {
    const hits = [
      { rule: rule({ id: 1 }), order: order(), ageBusinessHours: 30, openAlert: null },
      { rule: rule({ id: 2, channel: "alerts" }), order: order(), ageBusinessHours: 30, openAlert: null },
    ];
    expect([...groupByChannel(hits).keys()]).toEqual(["orders", "alerts"]);
    expect(countStuck(hits)).toEqual([{ storeKey: "aa", status: "Processing", count: 1 }]);
  });
});
