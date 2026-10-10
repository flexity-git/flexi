import { describe, expect, it } from "vitest";
import { addBusinessHours, businessHoursBetween, isBusinessDay } from "./business-hours.js";

const prague = { timeZone: "Europe/Prague" };
const d = (iso: string) => new Date(iso);

describe("businessHoursBetween", () => {
  it("counts full weekday hours", () => {
    // Tue 2026-10-06 10:00 local (08:00Z) to Wed 10:00 local
    expect(businessHoursBetween(d("2026-10-06T08:00:00Z"), d("2026-10-07T08:00:00Z"), prague)).toBe(24);
  });

  it("skips the weekend in local time, not UTC", () => {
    // Fri 2026-10-09 22:00 local (20:00Z) to Mon 2026-10-12 02:00 local (00:00Z):
    // 2 h of Friday + 2 h of Monday. A UTC-based count would differ.
    expect(businessHoursBetween(d("2026-10-09T20:00:00Z"), d("2026-10-12T00:00:00Z"), prague)).toBe(4);
  });

  it("is zero inside a weekend and negative when reversed", () => {
    expect(businessHoursBetween(d("2026-10-10T08:00:00Z"), d("2026-10-11T08:00:00Z"), prague)).toBe(0);
    expect(businessHoursBetween(d("2026-10-07T08:00:00Z"), d("2026-10-06T08:00:00Z"), prague)).toBe(-24);
  });

  it("handles the spring DST switch over a weekend", () => {
    // Fri 2026-03-27 12:00 CET (11:00Z) to Mon 2026-03-30 12:00 CEST (10:00Z)
    expect(businessHoursBetween(d("2026-03-27T11:00:00Z"), d("2026-03-30T10:00:00Z"), prague)).toBe(24);
  });

  it("handles the autumn DST switch over a weekend", () => {
    // Fri 2026-10-23 12:00 CEST (10:00Z) to Mon 2026-10-26 12:00 CET (11:00Z)
    expect(businessHoursBetween(d("2026-10-23T10:00:00Z"), d("2026-10-26T11:00:00Z"), prague)).toBe(24);
  });

  it("counts a 23 h business day when DST starts on a weekday at midnight", () => {
    // Africa/Cairo starts DST on the last Friday of April at 00:00 (2026-04-24).
    const cairo = { timeZone: "Africa/Cairo" };
    // Thu 2026-04-23 00:00 EET (22:00Z prev day) to Sat 2026-04-25 00:00 EEST (21:00Z)
    expect(businessHoursBetween(d("2026-04-22T22:00:00Z"), d("2026-04-24T21:00:00Z"), cairo)).toBe(47);
  });

  it("excludes holidays from a list or a predicate", () => {
    const start = d("2026-10-27T23:00:00Z"); // Wed 2026-10-28 00:00 CET
    const end = d("2026-10-28T23:00:00Z"); // Thu 00:00 CET
    expect(businessHoursBetween(start, end, prague)).toBe(24);
    expect(businessHoursBetween(start, end, { ...prague, holidays: ["2026-10-28"] })).toBe(0);
    expect(businessHoursBetween(start, end, { ...prague, holidays: (iso) => iso.endsWith("-10-28") })).toBe(0);
  });
});

describe("addBusinessHours", () => {
  it("returns the start for zero hours", () => {
    expect(addBusinessHours(d("2026-10-10T08:00:00Z"), 0, prague).toISOString()).toBe("2026-10-10T08:00:00.000Z");
  });

  it("rolls over a weekend forward", () => {
    // Fri 2026-10-09 20:00 local + 6 h = Mon 2026-10-12 02:00 local (00:00Z)
    expect(addBusinessHours(d("2026-10-09T18:00:00Z"), 6, prague).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });

  it("starts counting on Monday when started on a weekend", () => {
    expect(addBusinessHours(d("2026-10-10T12:00:00Z"), 1, prague).toISOString()).toBe("2026-10-11T23:00:00.000Z");
  });

  it("goes backwards for negative hours", () => {
    // Mon 2026-10-12 02:00 local - 6 h = Fri 2026-10-09 20:00 local
    expect(addBusinessHours(d("2026-10-12T00:00:00Z"), -6, prague).toISOString()).toBe("2026-10-09T18:00:00.000Z");
  });

  it("handles DST switches on both sides of a weekend", () => {
    // Spring: Fri 2026-03-27 20:00 CET + 6 h = Mon 2026-03-30 02:00 CEST (00:00Z)
    expect(addBusinessHours(d("2026-03-27T19:00:00Z"), 6, prague).toISOString()).toBe("2026-03-30T00:00:00.000Z");
    // Autumn: Fri 2026-10-23 20:00 CEST + 6 h = Mon 2026-10-26 02:00 CET (01:00Z)
    expect(addBusinessHours(d("2026-10-23T18:00:00Z"), 6, prague).toISOString()).toBe("2026-10-26T01:00:00.000Z");
  });

  it("counts a 25 h business day when DST ends on a weekday", () => {
    // Africa/Cairo ends DST on the last Thursday of October (2026-10-29), so that day has 25 h.
    const cairo = { timeZone: "Africa/Cairo" };
    const thuStart = d("2026-10-28T21:00:00Z"); // Thu 00:00 EEST
    const friStart = d("2026-10-29T22:00:00Z"); // Fri 00:00 EET
    expect(businessHoursBetween(thuStart, friStart, cairo)).toBe(25);
    expect(addBusinessHours(thuStart, 25, cairo).toISOString()).toBe(friStart.toISOString());
  });

  it("is the inverse of businessHoursBetween", () => {
    const start = d("2026-10-08T15:30:00Z");
    const end = addBusinessHours(start, 50, prague);
    expect(businessHoursBetween(start, end, prague)).toBeCloseTo(50, 9);
    expect(addBusinessHours(end, -50, prague).toISOString()).toBe(start.toISOString());
  });

  it("skips holidays and refuses an endless search", () => {
    const tue = d("2026-10-27T22:00:00Z"); // Tue 23:00 CET
    expect(addBusinessHours(tue, 2, { ...prague, holidays: ["2026-10-28"] }).toISOString()).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    expect(() => addBusinessHours(tue, 2, { ...prague, holidays: () => true })).toThrow(/No business day/);
  });
});

describe("isBusinessDay", () => {
  it("uses the local date", () => {
    // 2026-10-09T23:30Z is Saturday 01:30 in Prague but Friday in UTC.
    expect(isBusinessDay(d("2026-10-09T23:30:00Z"), prague)).toBe(false);
    expect(isBusinessDay(d("2026-10-09T21:30:00Z"), prague)).toBe(true);
  });
});
