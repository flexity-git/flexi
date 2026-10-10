import { defineModule } from "@flexity/core";
import { generateTask, validateTask } from "./tasks.js";

export default defineModule({
  name: "merchant-feed",
  description: "Builds Google Merchant, Heureka and Zbozi.cz product feeds from the local Shoptet mirror.",
  migrationsDir: new URL("../migrations", import.meta.url),
  tasks: {
    generate: {
      description:
        "Write a feed file: --feed=google|heureka|zbozi --store=<key> --out=<path> [--force]. Keeps the old file when the item count drops too far.",
      run: (ctx) => generateTask(ctx),
    },
    validate: {
      description: "Report feed problems without writing: --feed=google|heureka|zbozi --store=<key>.",
      run: (ctx) => validateTask(ctx),
    },
  },
  tables: [
    { name: "feed_rules", scope: "data:read", description: "Merchant feed rules: exclude items or override title and custom labels." },
    { name: "feed_runs", scope: "data:read", description: "One row per feed generation: item and error counts, and whether the file was written." },
  ],
});

export * from "./types.js";
export { isValidGtin, normalizeGtin } from "./gtin.js";
export { buildFeedItems, resolveAvailability, type AvailabilityMapping, type MapOptions, type MirrorRows } from "./mapping.js";
export { validateItems, type ValidationIssue, type ValidationResult } from "./validate.js";
export { render, renderGoogle, renderHeureka, renderZbozi, type RenderOptions } from "./render.js";
export { applyRules, parseRule, type FeedRule, type RuleMatch, type RuleSet } from "./rules.js";
export { checkBreaker, DEFAULT_MIN_RATIO } from "./circuit-breaker.js";
export { runPipeline, type PipelineResult } from "./pipeline.js";
export { readFeedSettings } from "./settings.js";
