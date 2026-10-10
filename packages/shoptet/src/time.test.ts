import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "./retry.js";
import { parseShoptetTimestamp, toShoptetTimestamp } from "./time.js";

describe("toShoptetTimestamp", () => {
  it("formats winter time with +0100 and drops milliseconds", () => {
    expect(toShoptetTimestamp("2026-01-15T09:30:45.678Z")).toBe("2026-01-15T10:30:45+0100");
  });

  it("formats summer time with +0200", () => {
    expect(toShoptetTimestamp(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02T00:00:00+0200");
  });

  it("supports other zones", () => {
    expect(toShoptetTimestamp("2026-01-15T09:30:00Z", "UTC")).toBe("2026-01-15T09:30:00+0000");
    expect(toShoptetTimestamp("2026-01-15T09:30:00Z", "America/New_York")).toBe("2026-01-15T04:30:00-0500");
  });

  it("throws on invalid input", () => {
    expect(() => toShoptetTimestamp("not a date")).toThrow(RangeError);
  });
});

describe("parseShoptetTimestamp", () => {
  it("round-trips with toShoptetTimestamp", () => {
    const ts = toShoptetTimestamp("2026-03-29T00:59:59Z");
    expect(parseShoptetTimestamp(ts).toISOString()).toBe("2026-03-29T00:59:59.000Z");
  });

  it("accepts offsets with a colon", () => {
    expect(parseShoptetTimestamp("2026-01-01T10:00:00+01:00").toISOString()).toBe("2026-01-01T09:00:00.000Z");
  });

  it("throws on garbage", () => {
    expect(() => parseShoptetTimestamp("yesterday")).toThrow(RangeError);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds, dates, caps and rejects garbage", () => {
    expect(parseRetryAfterMs("3", 60_000)).toBe(3_000);
    expect(parseRetryAfterMs("120", 60_000)).toBe(60_000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", 60_000, now)).toBe(10_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 2025 00:00:10 GMT", 60_000, now)).toBe(0);
    expect(parseRetryAfterMs("soon", 60_000)).toBeNull();
    expect(parseRetryAfterMs(null, 60_000)).toBeNull();
  });
});
