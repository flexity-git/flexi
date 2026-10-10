import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("writes one JSON line per call with bindings and serialized errors", () => {
    const out: string[] = [];
    const log = createLogger(
      { module: "demo" },
      { write: (l) => out.push(l), now: () => new Date("2026-01-01T00:00:00Z") },
    );
    log.child({ task: "check" }).error("boom", { err: new Error("bad") });
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("\n")).toBe(true);
    const record = JSON.parse(out[0]!);
    expect(record).toMatchObject({
      ts: "2026-01-01T00:00:00.000Z",
      level: "error",
      msg: "boom",
      module: "demo",
      task: "check",
      err: { name: "Error", message: "bad" },
    });
  });
});
