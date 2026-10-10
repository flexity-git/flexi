import { describe, expect, it } from "vitest";
import { hasScope, normalizeScopes, parseScopesStrict } from "./scopes.js";

describe("hasScope", () => {
  it.each([
    [["data:read"], "data:read", true],
    [["data:read"], "data:read:customers", false],
    [["data:read:customers"], "data:read:customers", false], // extends data:read, useless alone
    [["data:read", "data:read:customers"], "data:read:customers", true],
    [["shoptet:read"], "data:read", false],
    [["*"], "data:read", true],
    [["*"], "data:read:customers", true],
    [["*"], "shoptet:read", true],
    [["*"], "shoptet:write:products", false], // wildcard never grants writes
    [["*", "shoptet:write:products"], "shoptet:write:products", true],
    [["shoptet:write:products"], "shoptet:write:products", true],
    [[], "data:read", false],
    [["data:read"], "", false],
    [["data:read"], "data:", false], // no prefix matching
  ] as const)("%j has %s = %s", (granted, required, expected) => {
    expect(hasScope(granted, required)).toBe(expected);
  });

  it("treats null and undefined as no scopes", () => {
    expect(hasScope(null, "data:read")).toBe(false);
    expect(hasScope(undefined, "data:read")).toBe(false);
  });
});

describe("normalizeScopes", () => {
  it("trims, de-duplicates and separates unknown scopes", () => {
    expect(normalizeScopes(" data:read, data:read ,bogus,,shoptet:read")).toEqual({
      scopes: ["data:read", "shoptet:read"],
      unknown: ["bogus"],
      problems: [],
    });
  });

  it("flags an extending scope without its base", () => {
    expect(normalizeScopes(["data:read:customers"]).problems[0]).toMatch(/add data:read/);
  });
});

describe("parseScopesStrict", () => {
  it("throws on unknown scopes, missing base and empty input", () => {
    expect(() => parseScopesStrict("data:write", "X")).toThrow(/unknown scope "data:write"/);
    expect(() => parseScopesStrict("data:read:customers", "X")).toThrow(/extends data:read/);
    expect(() => parseScopesStrict(" , ", "X")).toThrow(/at least one scope/);
    expect(parseScopesStrict("data:read,data:read:customers", "X")).toEqual(["data:read", "data:read:customers"]);
  });
});
