import { createLogger, defineModule } from "@flexity/core";
import { describe, expect, it } from "vitest";
import type { DiscoveredModule } from "./discovery.js";
import { main } from "./main.js";

const TOKEN = "fake-token-should-never-print";
const env = { FLEXI_STORES: "sk", SHOPTET_TOKEN_SK: TOKEN, FLEXI_SLACK_WEBHOOK_ALERTS: "https://hooks.example/x" };

const demo: DiscoveredModule = {
  packageName: "@flexity/module-demo",
  dir: "/nowhere",
  module: defineModule({
    name: "demo",
    description: "Demo module.",
    tasks: {
      echo: { description: "Echoes args.", run: async (ctx) => ({ args: ctx.args, now: ctx.now() instanceof Date }) },
      fail: {
        description: "Fails.",
        run: async () => {
          throw new Error("nope");
        },
      },
      client: { description: "Uses Shoptet.", run: async (ctx) => ({ client: ctx.shoptet("sk") }) },
    },
  }),
};

async function cli(argv: string[], extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const logs: string[] = [];
  const code = await main(argv, {
    env: { ...env, ...extraEnv },
    out: (l) => out.push(l),
    log: createLogger({}, { write: (l) => logs.push(l) }),
    discover: async () => [demo],
    loadShoptet: async () => ({ ok: true, pkg: { createShoptetClient: () => ({ kind: "fake-client" }) } }),
    checkDatabase: async () => ({ error: null, migrations: 3 }),
  });
  return { code, out: out.join("\n"), logs: logs.join("") };
}

describe("flexi cli", () => {
  it("doctor reports without printing secrets", async () => {
    const r = await cli(["doctor"], { FLEXI_DATABASE_URL: "postgres://u:secret-pass@db.example/flexi" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("stores: sk (primary)");
    expect(r.out).toContain("database: reachable, 3 migrations applied");
    expect(r.out).toContain("slack alerts: configured");
    expect(r.out).toContain("slack orders: not configured (FLEXI_SLACK_WEBHOOK_ORDERS)");
    expect(r.out).toContain("modules: demo");
    const all = r.out + r.logs;
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("secret-pass");
    expect(all).not.toContain("hooks.example");
  });

  it("doctor exits 1 on invalid config", async () => {
    const r = await cli(["doctor"], { SHOPTET_TOKEN_SK: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("SHOPTET_TOKEN_SK is missing");
  });

  it("list prints modules and tasks", async () => {
    const r = await cli(["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("demo:echo  Echoes args.");
  });

  it("run passes options to the task and prints the summary", async () => {
    const r = await cli(["run", "demo:echo", "--store=sk", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      ok: true,
      module: "demo",
      task: "echo",
      summary: { args: { store: "sk", "dry-run": true }, now: true },
    });
  });

  it("run builds Shoptet clients through the factory", async () => {
    const r = await cli(["run", "demo:client"]);
    expect(JSON.parse(r.out).summary).toEqual({ client: { kind: "fake-client" } });
  });

  it("run exits 1 when the task fails or the target is unknown", async () => {
    expect((await cli(["run", "demo:fail"])).code).toBe(1);
    const unknownTask = await cli(["run", "demo:missing"]);
    expect(unknownTask.code).toBe(1);
    expect(unknownTask.logs).toContain("has no task");
    expect((await cli(["run", "other:echo"])).code).toBe(1);
    expect((await cli(["run"])).code).toBe(1);
  });

  it("rejects unknown commands and stray arguments", async () => {
    expect((await cli(["frobnicate"])).code).toBe(1);
    expect((await cli(["list", "extra"])).code).toBe(1);
    expect((await cli(["--help"])).code).toBe(0);
  });
});
