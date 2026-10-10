import { getStore, type TaskContext, type TaskSummary } from "@flexity/core";
import { checkBreaker } from "./circuit-breaker.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import { lastWrittenCount, loadMirrorRows, loadRuleRows, recordRun, type Queryable } from "./repository.js";
import { parseRule, type FeedRule } from "./rules.js";
import { readFeedSettings, type Env, type FeedSettings } from "./settings.js";
import { FEEDS, type FeedName } from "./types.js";
import type { ValidationIssue } from "./validate.js";
import { writeFileAtomic } from "./write.js";

export interface TaskDeps {
  env?: Env;
  writeFile?: (path: string, content: string) => Promise<void>;
}

const MAX_ISSUES_IN_SUMMARY = 50;

function stringArg(ctx: TaskContext, name: string): string | undefined {
  const value = ctx.args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${name} needs a value, e.g. --${name}=...`);
  return value.trim();
}

function feedArg(ctx: TaskContext): FeedName {
  const feed = stringArg(ctx, "feed");
  if (!feed || !(FEEDS as readonly string[]).includes(feed)) throw new Error(`--feed must be one of ${FEEDS.join(", ")}.`);
  return feed as FeedName;
}

function requireDb(ctx: TaskContext): Queryable {
  if (!ctx.db) throw new Error("merchant-feed reads the local mirror and needs FLEXI_DATABASE_URL.");
  return ctx.db as unknown as Queryable;
}

interface Prepared {
  feed: FeedName;
  storeKey: string;
  settings: FeedSettings;
  result: PipelineResult;
}

async function prepare(ctx: TaskContext, deps: TaskDeps): Promise<Prepared & { db: Queryable }> {
  const feed = feedArg(ctx);
  const storeArg = stringArg(ctx, "store");
  if (!storeArg) throw new Error("--store is required, e.g. --store=" + (ctx.config.stores[0]?.key ?? "sk") + ".");
  const store = getStore(ctx.config, storeArg);
  const settings = readFeedSettings(deps.env ?? process.env);
  const db = requireDb(ctx);
  if (!store.url) ctx.log.warn("Store has no public URL; relative product links cannot be resolved.", { store: store.key });

  const ruleRows = await loadRuleRows(db, feed, store.key);
  const rules: FeedRule[] = [];
  const invalid: string[] = [];
  for (const row of ruleRows) {
    const parsed = parseRule(row);
    if (parsed.ok) rules.push(parsed.rule);
    else invalid.push(`rule ${parsed.id}: ${parsed.reason}`);
  }
  // A skipped exclude rule would publish products the merchant chose to hide,
  // so an invalid rule stops the run instead of being ignored.
  if (invalid.length > 0) throw new Error(`Invalid feed_rules (fix or disable them):\n  - ${invalid.join("\n  - ")}`);

  const rows = await loadMirrorRows(db, store.key);
  const result = runPipeline({
    feed,
    storeKey: store.key,
    rows,
    rules,
    map: {
      ...(store.url ? { storeUrl: store.url } : {}),
      availability: settings.availability,
      publishedVisibility: settings.publishedVisibility,
    },
    render: {
      title: `${store.key} ${feed} feed`,
      ...(store.url ? { storeUrl: store.url } : {}),
      ...(settings.deliveryDaysNotInStock !== undefined ? { deliveryDaysNotInStock: settings.deliveryDaysNotInStock } : {}),
    },
  });
  return { feed, storeKey: store.key, settings, result, db };
}

function issueCounts(issues: readonly ValidationIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[`${issue.severity}:${issue.code}`] = (counts[`${issue.severity}:${issue.code}`] ?? 0) + 1;
  return counts;
}

export async function generateTask(ctx: TaskContext, deps: TaskDeps = {}): Promise<TaskSummary> {
  const out = stringArg(ctx, "out");
  if (!out) throw new Error("--out is required: path of the published feed file.");
  const force = ctx.args.force === true;
  const { feed, storeKey, settings, result, db } = await prepare(ctx, deps);

  const itemCount = result.items.length;
  const previous = await lastWrittenCount(db, feed, storeKey);
  const decision = checkBreaker(itemCount, previous, settings.minRatio);
  const write = decision.write || (force && itemCount > 0);

  if (write) {
    await (deps.writeFile ?? writeFileAtomic)(out, result.xml);
    if (!decision.write) ctx.log.warn("Circuit breaker overridden with --force.", { feed, store: storeKey, reason: decision.reason });
  } else {
    await ctx.notify(
      "products",
      `Merchant feed ${feed} for store ${storeKey} was not published. ${decision.reason} The previous file is still served. ` +
        `Check the mirror sync and feed_rules, then rerun (add --force if the drop is intended).`,
    );
  }
  await recordRun(db, { feed, storeKey, itemCount, errorCount: result.errorCount, written: write });

  const summary = {
    feed,
    store: storeKey,
    written: write,
    breaker: decision.reason,
    items: itemCount,
    previousItems: previous,
    candidates: result.candidates,
    excludedByRules: result.excludedByRules,
    excludedByErrors: result.errorCount,
    issues: issueCounts(result.issues),
  };
  ctx.log.info("Merchant feed generated.", summary);
  return summary;
}

export async function validateTask(ctx: TaskContext, deps: TaskDeps = {}): Promise<TaskSummary> {
  const { feed, storeKey, result } = await prepare(ctx, deps);
  for (const issue of result.issues.slice(0, MAX_ISSUES_IN_SUMMARY)) {
    ctx.log[issue.severity === "error" ? "error" : "warn"](issue.message, { item: issue.itemId, code: issue.code });
  }
  return {
    feed,
    store: storeKey,
    items: result.items.length,
    candidates: result.candidates,
    excludedByRules: result.excludedByRules,
    excludedByErrors: result.errorCount,
    issues: issueCounts(result.issues),
    firstIssues: result.issues.slice(0, MAX_ISSUES_IN_SUMMARY),
  };
}
