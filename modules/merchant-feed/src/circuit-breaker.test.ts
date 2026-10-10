import { describe, expect, it } from "vitest";
import { checkBreaker } from "./circuit-breaker.js";

describe("checkBreaker", () => {
  it("writes the first run", () => {
    expect(checkBreaker(10, null).write).toBe(true);
  });

  it("never writes an empty first feed", () => {
    expect(checkBreaker(0, null).write).toBe(false);
  });

  it("writes at or above the ratio", () => {
    expect(checkBreaker(70, 100).write).toBe(true);
    expect(checkBreaker(150, 100).write).toBe(true);
  });

  it("blocks below the ratio and explains why", () => {
    expect(checkBreaker(69, 100)).toEqual({
      write: false,
      reason: "Item count fell from 100 to 69 (69%, minimum 70%).",
    });
    expect(checkBreaker(0, 100).write).toBe(false);
  });

  it("honours a custom ratio", () => {
    expect(checkBreaker(40, 100, 0.5).write).toBe(false);
    expect(checkBreaker(60, 100, 0.5).write).toBe(true);
  });
});
