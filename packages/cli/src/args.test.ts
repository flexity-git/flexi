import { describe, expect, it } from "vitest";
import { parseArgs, parseTarget } from "./args.js";

describe("parseArgs", () => {
  it("splits command, positionals and options", () => {
    expect(parseArgs(["run", "stuck-orders:check", "--store=sk", "--dry-run", "--limit=10"])).toEqual({
      command: "run",
      positionals: ["stuck-orders:check"],
      options: { store: "sk", "dry-run": true, limit: "10" },
      help: false,
    });
  });

  it("keeps empty values and values containing '='", () => {
    expect(parseArgs(["run", "a:b", "--q=", "--filter=a=b"]).options).toEqual({ q: "", filter: "a=b" });
  });

  it("does not let a flag swallow the next positional", () => {
    expect(parseArgs(["run", "--dry-run", "a:b"]).positionals).toEqual(["a:b"]);
  });

  it("recognises help and the -- terminator", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs([]).command).toBeNull();
    expect(parseArgs(["run", "--", "--not-an-option"]).positionals).toEqual(["--not-an-option"]);
  });

  it("rejects malformed and repeated options", () => {
    expect(() => parseArgs(["run", "-x"])).toThrow(/short option/);
    expect(() => parseArgs(["run", "--=1"])).toThrow(/Invalid option name/);
    expect(() => parseArgs(["run", "--a=1", "--a=2"])).toThrow(/more than once/);
  });
});

describe("parseTarget", () => {
  it("parses module:task", () => {
    expect(parseTarget("stuck-orders:check")).toEqual({ module: "stuck-orders", task: "check" });
  });

  it("rejects anything else", () => {
    expect(() => parseTarget(undefined)).toThrow(/Expected <module>:<task>/);
    expect(() => parseTarget("stuck-orders")).toThrow(/got "stuck-orders"/);
    expect(() => parseTarget("a:b:c")).toThrow();
  });
});
