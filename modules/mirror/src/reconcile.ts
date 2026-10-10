import type { VariantSnapshot } from "./db.js";

export interface VisibilityDifference {
  code: string;
  primary: { visible: boolean | null; productVisibility: string | null };
  store: { visible: boolean | null; productVisibility: string | null };
}

export interface StoreDiff {
  store: string;
  /** Variant codes that exist in the primary store but not in this one. */
  missing: string[];
  /** Variant codes that exist only in this store. */
  extra: string[];
  visibility: VisibilityDifference[];
}

/** Compares one store's variants against the primary store by variant code. */
export function diffStore(store: string, primary: readonly VariantSnapshot[], other: readonly VariantSnapshot[]): StoreDiff {
  const primaryByCode = new Map(primary.map((v) => [v.code, v]));
  const otherByCode = new Map(other.map((v) => [v.code, v]));
  const missing = [...primaryByCode.keys()].filter((code) => !otherByCode.has(code)).sort();
  const extra = [...otherByCode.keys()].filter((code) => !primaryByCode.has(code)).sort();
  const visibility: VisibilityDifference[] = [];
  for (const [code, p] of primaryByCode) {
    const o = otherByCode.get(code);
    if (!o) continue;
    if (p.visible !== o.visible || p.productVisibility !== o.productVisibility) {
      visibility.push({
        code,
        primary: { visible: p.visible, productVisibility: p.productVisibility },
        store: { visible: o.visible, productVisibility: o.productVisibility },
      });
    }
  }
  visibility.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { store, missing, extra, visibility };
}

export function hasDifferences(diff: StoreDiff): boolean {
  return diff.missing.length > 0 || diff.extra.length > 0 || diff.visibility.length > 0;
}

const SAMPLE = 5;

function sample(codes: readonly string[]): string {
  const shown = codes.slice(0, SAMPLE).join(", ");
  return codes.length > SAMPLE ? `${shown} and ${codes.length - SAMPLE} more` : shown;
}

/** Short Slack text. Returns null when there is nothing to report. */
export function formatReconcileMessage(primaryStore: string, diffs: readonly StoreDiff[]): string | null {
  const changed = diffs.filter(hasDifferences);
  if (changed.length === 0) return null;
  const lines = [`Catalogue differences against primary store "${primaryStore}":`];
  for (const d of changed) {
    const parts: string[] = [];
    if (d.missing.length > 0) parts.push(`${d.missing.length} missing (${sample(d.missing)})`);
    if (d.extra.length > 0) parts.push(`${d.extra.length} only here (${sample(d.extra)})`);
    if (d.visibility.length > 0) parts.push(`${d.visibility.length} visibility differences (${sample(d.visibility.map((v) => v.code))})`);
    lines.push(`- ${d.store}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}
