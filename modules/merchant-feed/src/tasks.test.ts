import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type FlexiConfig, type TaskArgs, type TaskContext } from "@flexity/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedRuleRow } from "./rules.js";
import { generateTask, validateTask } from "./tasks.js";
import { categories, product, STORE_URL, variant } from "./test-fixtures.js";
import type { MirrorVariant } from "./types.js";

interface FakeState {
  variants: MirrorVariant[];
  rules: FeedRuleRow[];
  runs: Array<{ item_count: number; written: boolean; params: unknown[] }>;
}

function fakeDb(state: FakeState) {
  return {
    async query(text: string, params: unknown[] = []) {
      if (text.includes("from shoptet_products")) return { rows: [product()] };
      if (text.includes("from shoptet_product_variants")) return { rows: state.variants };
      if (text.includes("from shoptet_categories")) return { rows: categories };
      if (text.includes("from feed_rules")) return { rows: state.rules };
      if (text.includes("from feed_runs")) {
        const last = state.runs.filter((r) => r.written).at(-1);
        return { rows: last ? [{ item_count: last.item_count }] : [] };
      }
      if (text.startsWith("insert into feed_runs")) {
        state.runs.push({ item_count: params[2] as number, written: params[4] as boolean, params });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const config: FlexiConfig = {
  stores: [{ key: "sk", token: "test-token", url: STORE_URL }],
  primaryStore: "sk",
  slack: {},
  timezone: "Europe/Prague",
  modules: null,
};

let dir: string;
let state: FakeState;
const notify = vi.fn(async () => ({ delivered: false }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flexi-feed-"));
  state = {
    variants: Array.from({ length: 10 }, (_, i) => variant({ code: `MAT-${i}`, ean: null })),
    rules: [],
    runs: [],
  };
  notify.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(args: TaskArgs): TaskContext {
  return {
    config,
    db: fakeDb(state) as unknown as TaskContext["db"],
    shoptet: () => ({}),
    notify,
    log: createLogger({}, { write: () => {} }),
    now: () => new Date("2026-10-10T08:00:00Z"),
    args,
  };
}

describe("generate task", () => {
  it("writes the feed atomically and records the run", async () => {
    const out = join(dir, "google.xml");
    const summary = await generateTask(ctx({ feed: "google", store: "sk", out }), { env: {} });
    expect(summary).toMatchObject({ written: true, items: 10, previousItems: null });
    const xml = await readFile(out, "utf8");
    expect(xml.match(/<item>/g)).toHaveLength(10);
    expect(xml).toContain("<link>https://shop.example/example-mat/</link>");
    expect(await readdir(dir)).toEqual(["google.xml"]);
    expect(state.runs).toEqual([expect.objectContaining({ item_count: 10, written: true })]);
  });

  it("keeps the old file and notifies when the item count drops below the ratio", async () => {
    const out = join(dir, "heureka.xml");
    await generateTask(ctx({ feed: "heureka", store: "sk", out }), { env: {} });
    state.variants = state.variants.slice(0, 6);
    await writeFile(out, "previous", "utf8");

    const summary = await generateTask(ctx({ feed: "heureka", store: "sk", out }), { env: {} });
    expect(summary).toMatchObject({ written: false, items: 6, previousItems: 10 });
    expect(await readFile(out, "utf8")).toBe("previous");
    expect(notify).toHaveBeenCalledWith("products", expect.stringContaining("Item count fell from 10 to 6"));
    expect(state.runs.at(-1)).toMatchObject({ item_count: 6, written: false });

    // The blocked run does not become the new baseline.
    state.variants = state.variants.slice(0, 6);
    const again = await generateTask(ctx({ feed: "heureka", store: "sk", out }), { env: {} });
    expect(again).toMatchObject({ written: false, previousItems: 10 });
  });

  it("writes despite the breaker with --force", async () => {
    const out = join(dir, "zbozi.xml");
    await generateTask(ctx({ feed: "zbozi", store: "sk", out }), { env: {} });
    state.variants = state.variants.slice(0, 2);
    const summary = await generateTask(ctx({ feed: "zbozi", store: "sk", out, force: true }), { env: {} });
    expect(summary).toMatchObject({ written: true, items: 2 });
    expect((await readFile(out, "utf8")).match(/<SHOPITEM>/g)).toHaveLength(2);
  });

  it("uses the configured ratio", async () => {
    const out = join(dir, "google.xml");
    await generateTask(ctx({ feed: "google", store: "sk", out }), { env: {} });
    state.variants = state.variants.slice(0, 6);
    const summary = await generateTask(ctx({ feed: "google", store: "sk", out }), { env: { FLEXI_FEED_MIN_RATIO: "0.5" } });
    expect(summary).toMatchObject({ written: true });
  });

  it("applies rules from feed_rules", async () => {
    state.rules = [{ id: 1, feed: "*", store_key: null, match: { code_prefix: "MAT-1" }, action: "exclude", set: null, enabled: true }];
    const out = join(dir, "google.xml");
    const summary = await generateTask(ctx({ feed: "google", store: "sk", out }), { env: {} });
    expect(summary).toMatchObject({ items: 9, excludedByRules: 1 });
  });

  it("refuses to run with an invalid rule", async () => {
    state.rules = [{ id: 7, feed: "*", store_key: null, match: {}, action: "exclude", set: null, enabled: true }];
    await expect(generateTask(ctx({ feed: "google", store: "sk", out: join(dir, "f.xml") }), { env: {} })).rejects.toThrow(
      "rule 7: match is empty",
    );
  });

  it("validates arguments", async () => {
    await expect(generateTask(ctx({ feed: "other", store: "sk", out: "x" }), { env: {} })).rejects.toThrow("--feed must be one of");
    await expect(generateTask(ctx({ feed: "google", out: "x" }), { env: {} })).rejects.toThrow("--store is required");
    await expect(generateTask(ctx({ feed: "google", store: "cz", out: "x" }), { env: {} })).rejects.toThrow('Unknown store "cz"');
    await expect(generateTask(ctx({ feed: "google", store: "sk" }), { env: {} })).rejects.toThrow("--out is required");
  });

  it("needs a database", async () => {
    const noDb = { ...ctx({ feed: "google", store: "sk", out: "x" }), db: null };
    await expect(generateTask(noDb, { env: {} })).rejects.toThrow("FLEXI_DATABASE_URL");
  });
});

describe("validate task", () => {
  it("reports issues without writing or recording a run", async () => {
    state.variants = [variant({ code: "A", ean: "123" }), variant({ code: "B", image_url: null })];
    const summary = await validateTask(ctx({ feed: "google", store: "sk" }), { env: {} });
    expect(summary).toMatchObject({
      items: 1,
      excludedByErrors: 1,
      issues: { "warning:invalid_gtin": 1, "error:missing_image": 1 },
    });
    expect(state.runs).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});
