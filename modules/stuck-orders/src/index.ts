import { defineModule } from "@flexity/core";
import { runCheck, runReport } from "./tasks.js";

export default defineModule({
  name: "stuck-orders",
  description: "Alerts when orders sit in a status longer than the merchant's rules allow (business hours).",
  migrationsDir: new URL("../migrations", import.meta.url),
  tasks: {
    check: {
      description:
        "Checks mirror freshness, evaluates stuck_order_rules and posts one Slack message per channel. Options: --dry-run, --cooldown-hours=24, --max-mirror-age-hours=3, --lookback-days=30, --max-lines=20, --holidays=YYYY-MM-DD,...",
      run: runCheck,
    },
    report: {
      description: "Counts orders currently over a rule threshold, per store and status. Never notifies or writes.",
      run: runReport,
    },
  },
  tables: [
    {
      name: "stuck_order_rules",
      scope: "data:read",
      description: "Merchant-defined rules: max business hours an order may stay in a status, per store or for all stores.",
    },
    {
      name: "stuck_order_alerts",
      scope: "data:read",
      description: "One row per announced stuck order and rule: first and last alert time, count, and when it was resolved.",
    },
  ],
});

export { evaluate, findStaleStores, ruleMatchesOrder } from "./evaluate.js";
export type { MirrorOrder, OpenAlert, StuckHit, StuckRule } from "./evaluate.js";
