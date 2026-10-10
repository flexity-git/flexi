import { parseShoptetTimestamp } from "@flexity/shoptet";
import type { FlexiConfig, TaskArgs } from "@flexity/core";

/** Shoptet sends numbers as strings ("138.00"). Returns null for missing or non-numeric values. */
export function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function toBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Reads `obj[key]` when obj is a plain object. */
export function field(obj: unknown, key: string): unknown {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) return (obj as Record<string, unknown>)[key];
  return undefined;
}

/** Parses a Shoptet or ISO timestamp. Returns null for missing or invalid input. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return parseShoptetTimestamp(value);
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `task` over `items` with at most `concurrency` in flight, preserving order of results. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

/** Store keys selected by `--store=<key>`, or every configured store. */
export function selectStores(config: FlexiConfig, args: TaskArgs): string[] {
  const requested = args.store;
  if (requested === undefined) return config.stores.map((s) => s.key);
  if (typeof requested !== "string" || requested.length === 0) throw new Error("--store needs a value, e.g. --store=sk.");
  if (!config.stores.some((s) => s.key === requested)) {
    const known = config.stores.map((s) => s.key).join(", ");
    throw new Error(`Unknown store "${requested}". Configured stores: ${known || "(none)"}.`);
  }
  return [requested];
}

/** Parses an optional positive integer option such as `--max-pages=2000`. */
export function intArg(args: TaskArgs, name: string): number | undefined {
  const raw = args[name];
  if (raw === undefined) return undefined;
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer.`);
  return n;
}
