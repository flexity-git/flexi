import { describe, expect, it } from "vitest";
import { ConfigError, getStore, loadConfig, redactConfig } from "./config.js";

const FAKE_TOKEN = "fake-token-not-real-0000";

const base = {
  FLEXI_STORES: "sk, cz",
  SHOPTET_TOKEN_SK: FAKE_TOKEN,
  SHOPTET_TOKEN_CZ: "fake-token-not-real-1111",
};

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).issues;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("parses a minimal config with defaults", () => {
    const config = loadConfig(base);
    expect(config.stores.map((s) => s.key)).toEqual(["sk", "cz"]);
    expect(config.primaryStore).toBe("sk");
    expect(config.timezone).toBe("Europe/Prague");
    expect(config.modules).toBeNull();
    expect(config.slack).toEqual({});
    expect(config.databaseUrl).toBeUndefined();
  });

  it("reads optional values", () => {
    const config = loadConfig({
      ...base,
      SHOPTET_STORE_CZ_URL: "https://shop.example",
      FLEXI_PRIMARY_STORE: "cz",
      FLEXI_DATABASE_URL: "postgres://user:pass@localhost:5432/flexi",
      FLEXI_SLACK_WEBHOOK_ALERTS: "https://hooks.example/alerts",
      FLEXI_TIMEZONE: "Europe/Bratislava",
      FLEXI_MODULES: "stuck-orders,feeds",
    });
    expect(getStore(config, "cz").url).toBe("https://shop.example");
    expect(config.primaryStore).toBe("cz");
    expect(config.databaseUrl).toMatch(/^postgres:/);
    expect(config.slack).toEqual({ alerts: "https://hooks.example/alerts" });
    expect(config.timezone).toBe("Europe/Bratislava");
    expect(config.modules).toEqual(["stuck-orders", "feeds"]);
  });

  it("names the missing variable", () => {
    expect(issuesOf({})).toEqual([expect.stringContaining("FLEXI_STORES is missing")]);
    expect(issuesOf({ FLEXI_STORES: "sk" })).toEqual([expect.stringContaining("SHOPTET_TOKEN_SK is missing")]);
  });

  it("collects every problem at once", () => {
    const issues = issuesOf({
      FLEXI_STORES: "sk,SK!,sk",
      FLEXI_PRIMARY_STORE: "hu",
      FLEXI_DATABASE_URL: "mysql://nope",
      FLEXI_SLACK_WEBHOOK_ORDERS: "not a url",
      FLEXI_TIMEZONE: "Mars/Olympus",
      FLEXI_MODULES: "Bad_Name",
    });
    const text = issues.join("\n");
    expect(text).toContain("SHOPTET_TOKEN_SK is missing");
    expect(text).toContain('invalid key "SK!"');
    expect(text).toContain('lists "sk" more than once');
    expect(text).toContain("FLEXI_PRIMARY_STORE");
    expect(text).toContain("FLEXI_DATABASE_URL");
    expect(text).toContain("FLEXI_SLACK_WEBHOOK_ORDERS");
    expect(text).toContain("FLEXI_TIMEZONE");
    expect(text).toContain("FLEXI_MODULES");
  });

  it("never echoes secret values in errors", () => {
    const secretHook = "https//secret-webhook-value";
    const secretDb = "mysql://user:secret-db-password@host/db";
    const err = (() => {
      try {
        loadConfig({
          ...base,
          SHOPTET_STORE_SK_URL: "secret-ish-url",
          FLEXI_SLACK_WEBHOOK_ALERTS: secretHook,
          FLEXI_DATABASE_URL: secretDb,
          FLEXI_STORES: "sk,cz,hu",
        });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected throw");
    })();
    expect(err.message).not.toContain(FAKE_TOKEN);
    expect(err.message).not.toContain(secretHook);
    expect(err.message).not.toContain("secret-db-password");
    expect(err.message).not.toContain("secret-ish-url");
  });

  it("treats blank values as missing", () => {
    expect(issuesOf({ FLEXI_STORES: "sk", SHOPTET_TOKEN_SK: "   " })).toEqual([
      expect.stringContaining("SHOPTET_TOKEN_SK is missing"),
    ]);
  });
});

describe("redactConfig and getStore", () => {
  it("masks tokens, webhooks and the database URL", () => {
    const config = loadConfig({
      ...base,
      FLEXI_DATABASE_URL: "postgres://user:pass@localhost/flexi",
      FLEXI_SLACK_WEBHOOK_PRODUCTS: "https://hooks.example/products",
    });
    const text = JSON.stringify(redactConfig(config));
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain("pass@");
    expect(text).not.toContain("hooks.example");
  });

  it("explains unknown store keys", () => {
    expect(() => getStore(loadConfig(base), "hu")).toThrow(/Unknown store "hu". Configured stores: sk, cz/);
  });
});
