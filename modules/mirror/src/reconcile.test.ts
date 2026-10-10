import { describe, expect, it } from "vitest";
import type { VariantSnapshot } from "./db.js";
import { diffStore, formatReconcileMessage, hasDifferences } from "./reconcile.js";

const v = (code: string, visible: boolean | null = true, productVisibility: string | null = "visible"): VariantSnapshot => ({
  code,
  productGuid: `p-${code}`,
  name: `Example ${code}`,
  visible,
  productVisibility,
});

describe("reconcile diff", () => {
  const primary = [v("A"), v("B"), v("C"), v("D", false)];

  it("finds missing codes, extra codes and visibility differences", () => {
    const diff = diffStore("cz", primary, [v("A"), v("C", true, "hidden"), v("D", true), v("Z")]);
    expect(diff.missing).toEqual(["B"]);
    expect(diff.extra).toEqual(["Z"]);
    expect(diff.visibility.map((d) => d.code)).toEqual(["C", "D"]);
    expect(diff.visibility[0]).toEqual({
      code: "C",
      primary: { visible: true, productVisibility: "visible" },
      store: { visible: true, productVisibility: "hidden" },
    });
    expect(hasDifferences(diff)).toBe(true);
  });

  it("reports nothing for identical catalogues", () => {
    const diff = diffStore("cz", primary, primary);
    expect(hasDifferences(diff)).toBe(false);
    expect(formatReconcileMessage("sk", [diff])).toBeNull();
  });

  it("formats a short message naming only stores with differences", () => {
    const changed = diffStore("cz", primary, [v("A")]);
    const same = diffStore("hu", primary, primary);
    const text = formatReconcileMessage("sk", [changed, same]);
    expect(text).toContain('primary store "sk"');
    expect(text).toContain("- cz: 3 missing (B, C, D)");
    expect(text).not.toContain("hu");
  });

  it("truncates long code lists", () => {
    const many = Array.from({ length: 8 }, (_, i) => v(`X${i}`));
    const text = formatReconcileMessage("sk", [diffStore("cz", many, [])]);
    expect(text).toContain("8 missing (X0, X1, X2, X3, X4 and 3 more)");
  });
});
