import { buildFeedItems, type MapOptions, type MirrorRows } from "./mapping.js";
import { render, type RenderOptions } from "./render.js";
import { applyRules, type FeedRule } from "./rules.js";
import type { FeedItem, FeedName } from "./types.js";
import { validateItems, type ValidationIssue } from "./validate.js";

export interface PipelineInput {
  feed: FeedName;
  storeKey: string;
  rows: MirrorRows;
  rules: readonly FeedRule[];
  map?: MapOptions;
  render?: RenderOptions;
}

export interface PipelineResult {
  xml: string;
  items: FeedItem[];
  issues: ValidationIssue[];
  /** Items built from the mirror, before rules. */
  candidates: number;
  excludedByRules: number;
  errorCount: number;
  ruleHits: Record<string, number>;
}

/** rows -> items -> rules -> validation -> XML. Pure. */
export function runPipeline(input: PipelineInput): PipelineResult {
  const built = buildFeedItems(input.rows, input.map);
  const ruled = applyRules(built, input.rules, { feed: input.feed, storeKey: input.storeKey });
  const validated = validateItems(ruled.items);
  return {
    xml: render(input.feed, validated.valid, input.render),
    items: validated.valid,
    issues: validated.issues,
    candidates: built.length,
    excludedByRules: ruled.excluded,
    errorCount: validated.errorCount,
    ruleHits: ruled.hits,
  };
}
