import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCatalog } from "./catalog.js";
import { parseCliArgs } from "./cli.js";
import { createHttpHandler, hostAllowed } from "./http.js";
import { buildDeps } from "./runtime.js";
import { makeDeps } from "./test-helpers.js";

const VALID = "flexi_valid_token_for_tests_only_0000000000000";

let server: Server;
let base: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

beforeAll(async () => {
  const { deps } = makeDeps();
  const handler = createHttpHandler(deps, {
    log,
    resolve: async (token) => (token === VALID ? { id: 9, name: "reader", scopes: ["shoptet:read"] } : null),
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeAllPools } = await import("./runtime.js");
  await closeAllPools();
});

const rpc = (method: string, id = 1, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const headers = (token?: string) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

describe("HTTP transport", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: headers(), body: rpc("tools/list") });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects an unknown token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: headers("flexi_wrong"), body: rpc("tools/list") });
    expect(res.status).toBe(401);
  });

  it("allows only POST on /mcp and answers health checks without auth", async () => {
    expect((await fetch(`${base}/mcp`, { headers: headers(VALID) })).status).toBe(405);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it("serves tools/list scoped to the token", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers(VALID),
      body: rpc("initialize", 1, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }),
    });
    expect(init.status).toBe(200);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: headers(VALID), body: rpc("tools/list", 2) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("shoptet_order_get");
    expect(names).not.toContain("query");
  });

  it("rejects malformed JSON", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: headers(VALID), body: "{" });
    expect(res.status).toBe(400);
  });
});

describe("parseCliArgs", () => {
  it("accepts --key=value and --key value forms", () => {
    expect(parseCliArgs(["token", "create", "--name", "Analyst", "--scopes=data:read,shoptet:read"])).toEqual({
      positionals: ["token", "create"],
      options: { name: "Analyst", scopes: "data:read,shoptet:read" },
    });
    expect(parseCliArgs(["--http", "--port", "9000"]).options).toEqual({ http: true, port: "9000" });
    expect(() => parseCliArgs(["--name"])).toThrow(/needs a value/);
  });
});

describe("buildCatalog", () => {
  it("refuses reserved tables and conflicting scopes", () => {
    expect(() => buildCatalog([{ name: "x", tables: [{ name: "flexi_api_tokens", scope: "data:read", description: "" }] }])).toThrow(
      /reserved/,
    );
    expect(() =>
      buildCatalog([
        { name: "a", tables: [{ name: "t", scope: "data:read", description: "" }] },
        { name: "b", tables: [{ name: "t", scope: "data:read:customers", description: "" }] },
      ]),
    ).toThrow(/with scope/);
  });
});

describe("DNS-rebinding protection", () => {
  it("accepts localhost hosts and rejects foreign Host or Origin", () => {
    const allowed = ["localhost", "127.0.0.1", "::1"];
    expect(hostAllowed({ host: "127.0.0.1:8787" }, allowed)).toBe(true);
    expect(hostAllowed({ host: "[::1]:8787" }, allowed)).toBe(true);
    expect(hostAllowed({ host: "localhost:8787", origin: "http://localhost:3000" }, allowed)).toBe(true);
    expect(hostAllowed({ host: "attacker.example" }, allowed)).toBe(false);
    expect(hostAllowed({ host: "localhost:8787", origin: "https://attacker.example" }, allowed)).toBe(false);
    expect(hostAllowed({ host: "localhost", origin: "null" }, allowed)).toBe(false);
    expect(hostAllowed({}, allowed)).toBe(false);
    expect(hostAllowed({ host: "mcp.shop.example" }, ["mcp.shop.example"])).toBe(true);
  });

  it("answers 403 to a request with a foreign Origin before authentication", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers(VALID), Origin: "https://attacker.example" },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(403);
  });
});

describe("HTTP mode database requirements", () => {
  const env = {
    FLEXI_STORES: "sk",
    SHOPTET_TOKEN_SK: "test-token-not-real-000000",
    FLEXI_DATABASE_URL: "postgres://flexi:x@127.0.0.1:1/flexi_test",
  };
  const discover = async () => [];

  it("refuses to start with SQL tools but without the dedicated reader login", async () => {
    await expect(buildDeps({ env, log, mode: "http", discover })).rejects.toThrow(/needs FLEXI_MCP_DATABASE_URL/);
  });

  it("starts in HTTP mode with a reader login, and stdio falls back to the main user", async () => {
    const http = await buildDeps({
      env: { ...env, FLEXI_MCP_DATABASE_URL: "postgres://flexi_mcp_reader:x@127.0.0.1:1/flexi_test" },
      log,
      mode: "http",
      discover,
    });
    expect(http.queryPool).not.toBe(http.db);
    const stdio = await buildDeps({ env, log, mode: "stdio", discover });
    expect(stdio.queryPool).not.toBeNull();
    expect(stdio.queryPool).not.toBe(stdio.db); // its own pool, separate from audit and tokens
  });

  it("rejects a customers login without a reader login", async () => {
    await expect(
      buildDeps({ env: { ...env, FLEXI_MCP_CUSTOMERS_DATABASE_URL: "postgres://c:x@127.0.0.1:1/flexi_test" }, log, discover }),
    ).rejects.toThrow(/needs FLEXI_MCP_DATABASE_URL as well/);
  });
});
