import type { BusinessHoursOptions, SlackChannel, TaskArgs, TaskContext, TaskSummary } from "@flexity/core";
import {
  buildStaleMessage,
  buildStuckMessage,
  countStuck,
  evaluate,
  findStaleStores,
  groupByChannel,
  type StaleStore,
} from "./evaluate.js";
import {
  loadCandidateOrders,
  loadEnabledRules,
  loadOpenAlerts,
  loadSyncState,
  markAlerted,
  markResolved,
  type Queryable,
} from "./repository.js";

export interface CheckOptions {
  dryRun: boolean;
  cooldownHours: number;
  maxMirrorAgeHours: number;
  lookbackDays: number;
  maxLines: number;
  holidays: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function positiveNumber(args: TaskArgs, name: string, fallback: number): number {
  const raw = args[name];
  if (raw === undefined) return fallback;
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number, e.g. --${name}=${fallback}.`);
  return value;
}

/** Parses and validates task options. Throws with a message naming the bad option. */
export function parseOptions(args: TaskArgs): CheckOptions {
  const dryRun = args["dry-run"];
  if (dryRun !== undefined && dryRun !== true && dryRun !== "true" && dryRun !== "false") {
    throw new Error("--dry-run takes no value (or true/false).");
  }
  const holidaysRaw = args.holidays;
  const holidays =
    typeof holidaysRaw === "string"
      ? holidaysRaw
          .split(",")
          .map((d) => d.trim())
          .filter((d) => d.length > 0)
      : [];
  if (holidaysRaw === true) throw new Error("--holidays needs a value, e.g. --holidays=2026-12-24,2026-12-25.");
  for (const d of holidays) {
    if (!ISO_DATE.test(d)) throw new Error(`--holidays contains "${d}", expected YYYY-MM-DD.`);
  }
  return {
    dryRun: dryRun === true || dryRun === "true",
    cooldownHours: positiveNumber(args, "cooldown-hours", 24),
    maxMirrorAgeHours: positiveNumber(args, "max-mirror-age-hours", 3),
    lookbackDays: positiveNumber(args, "lookback-days", 30),
    maxLines: Math.floor(positiveNumber(args, "max-lines", 20)),
    holidays,
  };
}

function requireDb(ctx: TaskContext): Queryable {
  if (!ctx.db) throw new Error("stuck-orders needs a database. Set FLEXI_DATABASE_URL and run `flexi migrate`.");
  return ctx.db;
}

function staleSummary(stale: readonly StaleStore[]) {
  return stale.map((s) => ({ storeKey: s.storeKey, lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null }));
}

interface Snapshot {
  options: CheckOptions;
  now: Date;
  freshStores: string[];
  stale: StaleStore[];
  evaluation: ReturnType<typeof evaluate>;
  ruleCount: number;
}

/** Reads rules, mirror freshness, candidate orders and open alerts, then evaluates. No writes. */
async function snapshot(ctx: TaskContext, db: Queryable): Promise<Snapshot> {
  const options = parseOptions(ctx.args);
  const now = ctx.now();
  const storeKeys = ctx.config.stores.map((s) => s.key);
  const stale = findStaleStores(storeKeys, await loadSyncState(db, storeKeys), now, options.maxMirrorAgeHours);
  const staleKeys = new Set(stale.map((s) => s.storeKey));
  const freshStores = storeKeys.filter((k) => !staleKeys.has(k));

  const rules = await loadEnabledRules(db);
  const businessHours: BusinessHoursOptions = { timeZone: ctx.config.timezone, holidays: options.holidays };
  const createdAfter = new Date(now.getTime() - options.lookbackDays * 86_400_000);
  const orders = freshStores.length > 0 ? await loadCandidateOrders(db, freshStores, rules, createdAfter) : [];
  const openAlerts = await loadOpenAlerts(db);
  const evaluation = evaluate({
    rules,
    orders,
    openAlerts,
    now,
    businessHours,
    cooldownHours: options.cooldownHours,
    checkedStores: freshStores,
  });
  return { options, now, freshStores, stale, evaluation, ruleCount: rules.length };
}

/**
 * `stuck-orders:check`. Order of work:
 * 1. Freshness guard: stores whose orders mirror is older than the limit are
 *    skipped, and ONE message says so (instead of a flood of false alerts).
 * 2. Evaluate the rules for the fresh stores.
 * 3. One message per channel with the due orders; only delivered messages mark
 *    orders as alerted, so a Slack failure retries on the next run.
 * 4. Resolve open alerts whose order left the status.
 */
export async function runCheck(ctx: TaskContext): Promise<TaskSummary> {
  const db = requireDb(ctx);
  const snap = await snapshot(ctx, db);
  const { options, now, stale, evaluation } = snap;
  const printed: { channel: SlackChannel; text: string }[] = [];
  const send = async (channel: SlackChannel, text: string): Promise<boolean> => {
    if (options.dryRun) {
      printed.push({ channel, text });
      ctx.log.info("dry run: message not sent", { channel, text });
      return false;
    }
    return (await ctx.notify(channel, text)).delivered;
  };

  let staleNotified = false;
  if (stale.length > 0) {
    const allStale = snap.freshStores.length === 0;
    staleNotified = await send("alerts", buildStaleMessage(stale, now, options.maxMirrorAgeHours, allStale));
  }

  const channels: Record<string, { due: number; delivered: boolean }> = {};
  let alerted = 0;
  for (const [channel, hits] of groupByChannel(evaluation.due)) {
    const delivered = await send(channel, buildStuckMessage(hits, options.maxLines));
    channels[channel] = { due: hits.length, delivered };
    if (delivered) {
      await markAlerted(db, hits, now);
      alerted += hits.length;
    } else if (!options.dryRun) {
      ctx.log.warn("stuck-order message not delivered; orders stay due for the next run", {
        channel,
        due: hits.length,
        webhookConfigured: Boolean(ctx.config.slack[channel]),
      });
    }
  }

  if (!options.dryRun) await markResolved(db, evaluation.resolve, now);

  return {
    dryRun: options.dryRun,
    rules: snap.ruleCount,
    checkedStores: snap.freshStores,
    staleStores: staleSummary(stale),
    staleNotified,
    stuck: evaluation.stuck.length,
    due: evaluation.due.length,
    alerted,
    // In a dry run nothing is written, so this is what would be resolved.
    resolved: evaluation.resolve.length,
    channels,
    ...(options.dryRun ? { messages: printed } : {}),
  };
}

/** `stuck-orders:report`. Counts orders currently over a rule threshold, per store and status. Never notifies or writes. */
export async function runReport(ctx: TaskContext): Promise<TaskSummary> {
  const db = requireDb(ctx);
  const snap = await snapshot(ctx, db);
  return {
    rules: snap.ruleCount,
    checkedStores: snap.freshStores,
    staleStores: staleSummary(snap.stale),
    stuck: countStuck(snap.evaluation.stuck),
    total: new Set(snap.evaluation.stuck.map((h) => `${h.order.storeKey}\u0000${h.order.code}`)).size,
  };
}
