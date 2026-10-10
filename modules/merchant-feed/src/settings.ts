import { DEFAULT_MIN_RATIO } from "./circuit-breaker.js";
import type { AvailabilityMapping } from "./mapping.js";
import { AVAILABILITIES, type Availability } from "./types.js";

export type Env = Record<string, string | undefined>;

export interface FeedSettings {
  availability: AvailabilityMapping;
  minRatio: number;
  deliveryDaysNotInStock?: number;
  publishedVisibility: string[];
}

/** Availability labels may contain commas, so lists are separated by `|`. */
function labels(value: string | undefined): string[] {
  return (value ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Reads optional FLEXI_FEED_* variables. Collects every problem before
 * throwing. Values are not secret, so messages may include them.
 */
export function readFeedSettings(env: Env): FeedSettings {
  const issues: string[] = [];

  const untrackedRaw = env.FLEXI_FEED_UNTRACKED_AVAILABILITY?.trim() || "in_stock";
  if (!(AVAILABILITIES as readonly string[]).includes(untrackedRaw)) {
    issues.push(`FLEXI_FEED_UNTRACKED_AVAILABILITY must be one of ${AVAILABILITIES.join(", ")}.`);
  }

  let minRatio = DEFAULT_MIN_RATIO;
  const ratioRaw = env.FLEXI_FEED_MIN_RATIO?.trim();
  if (ratioRaw) {
    minRatio = Number(ratioRaw);
    if (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1) issues.push("FLEXI_FEED_MIN_RATIO must be a number from 0 to 1, e.g. 0.7.");
  }

  let deliveryDaysNotInStock: number | undefined;
  const daysRaw = env.FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK?.trim();
  if (daysRaw) {
    deliveryDaysNotInStock = Number(daysRaw);
    if (!Number.isInteger(deliveryDaysNotInStock) || deliveryDaysNotInStock < 0) {
      issues.push("FLEXI_FEED_DELIVERY_DAYS_NOT_IN_STOCK must be a whole number of days.");
    }
  }

  const visibility = (env.FLEXI_FEED_VISIBILITY ?? "visible")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (issues.length > 0) throw new Error(`Invalid merchant-feed settings:\n${issues.map((i) => `  - ${i}`).join("\n")}`);

  return {
    availability: {
      inStock: labels(env.FLEXI_FEED_IN_STOCK_LABELS),
      outOfStock: labels(env.FLEXI_FEED_OUT_OF_STOCK_LABELS),
      preorder: labels(env.FLEXI_FEED_PREORDER_LABELS),
      untracked: untrackedRaw as Availability,
    },
    minRatio,
    ...(deliveryDaysNotInStock !== undefined ? { deliveryDaysNotInStock } : {}),
    publishedVisibility: visibility.length > 0 ? visibility : ["visible"],
  };
}
