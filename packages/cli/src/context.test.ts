import { createLogger, defineModule, loadConfig } from "@flexity/core";
import { describe, expect, it, vi } from "vitest";
import { buildTaskContext, createShoptetFactory, runTask, type Queryable } from "./context.js";

const quiet = createLogger({}, { write: () => {} });
const config = loadConfig({ FLEXI_STORES: "sk,cz", SHOPTET_TOKEN_SK: "fake-sk", SHOPTET_TOKEN_CZ: "fake-cz" });

function fakeDb(insertError?: Error & { code?: string }) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db: Queryable = {
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("insert") && insertError) throw insertError;
      return { rows: text.startsWith("insert") ? [{ id: 7 }] : [] };
    },
  };
  return { db, calls };
}

const demo = defineModule({
  name: "demo",
  description: "Demo module.",
  tasks: {
    ok: { description: "Succeeds.", run: async (ctx) => ({ store: ctx.args.store ?? null }) },
    boom: {
      description: "Fails.",
      run: async () => {
        throw new Error("upstream said no");
      },
    },
  },
});

function ctxFor(args: Record<string, string | boolean> = {}) {
  return buildTaskContext({
    config,
    db: null,
    notifier: { notify: async () => ({ delivered: false }), isConfigured: () => false },
    log: quiet,
    args,
    shoptet: () => ({}),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
}

describe("runTask", () => {
  it("records a successful run with its summary", async () => {
    const { db, calls } = fakeDb();
    const outcome = await runTask({ module: demo, taskName: "ok", ctx: ctxFor({ store: "sk" }), db, log: quiet });
    expect(outcome).toEqual({ ok: true, summary: { store: "sk" } });
    expect(calls[0]!.params).toEqual(["demo", "ok"]);
    expect(calls[1]!.text).toMatch(/^update flexi_task_runs/);
    expect(calls[1]!.params).toEqual(["7", "ok", null, JSON.stringify({ store: "sk" })]);
  });

  it("records a failure and returns ok: false", async () => {
    const { db, calls } = fakeDb();
    const outcome = await runTask({ module: demo, taskName: "boom", ctx: ctxFor(), db, log: quiet });
    expect(outcome).toEqual({ ok: false, error: "upstream said no" });
    expect(calls[1]!.params).toEqual(["7", "failed", "upstream said no", null]);
  });

  it("still runs the task when flexi_task_runs is missing", async () => {
    const err = Object.assign(new Error('relation "flexi_task_runs" does not exist'), { code: "42P01" });
    const { db, calls } = fakeDb(err);
    const outcome = await runTask({ module: demo, taskName: "ok", ctx: ctxFor(), db, log: quiet });
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("works without a database", async () => {
    await expect(runTask({ module: demo, taskName: "ok", ctx: ctxFor(), db: null, log: quiet })).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("createShoptetFactory", () => {
  it("creates one client per store with that store's token", () => {
    const createShoptetClient = vi.fn((opts: { token: string }) => ({ token: opts.token }));
    const factory = createShoptetFactory(config, { ok: true, pkg: { createShoptetClient } });
    expect(factory("cz")).toEqual({ token: "fake-cz" });
    expect(factory("cz")).toBe(factory("cz"));
    expect(createShoptetClient).toHaveBeenCalledTimes(1);
    expect(() => factory("hu")).toThrow(/Unknown store "hu"/);
  });

  it("explains a missing @flexity/shoptet only when a client is requested", () => {
    const factory = createShoptetFactory(config, { ok: false, reason: "@flexity/shoptet could not be loaded" });
    expect(() => factory("sk")).toThrow(/could not be loaded/);
  });
});
