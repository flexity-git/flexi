---
name: flexi-module-author
description: Use when building a new flexi module (a folder in modules/ that adds a capability such as a feed, a carrier, a bank import or an alert), or when reviewing one before a pull request. Covers the module contract, migrations, exposed tables and scopes, tasks, synthetic tests and Shoptet limits.
---

# Building a flexi module

A module is one business capability in `modules/<name>/`, published as
`@flexity/module-<name>`. The contract is in `docs/ARCHITECTURE.md#module-contract`
and `packages/core/src/module.ts`. Read both before starting; this skill is the checklist
around them.

## When to use

- Adding a new capability to flexi.
- Reviewing a module PR, your own or someone else's.

## Steps

### 1. Scope it

Write down in two sentences: what the module reads, what it writes, who gets notified.
If it needs a decision only the merchant can make (thresholds, status IDs, channels),
that becomes env or a rules table, not a constant.

### 2. Layout

```
modules/<name>/
  package.json        name @flexity/module-<name>, "type": "module", exports "." -> ./src/index.ts
  tsconfig.json       copy from an existing module
  migrations/0001_<name>.sql
  src/index.ts        default export = defineModule(...)
  src/*.test.ts
  README.md           what it does, env, tasks, an example rule
```

The CLI discovers any installed `@flexity/module-*` package, so the name matters.

### 3. Manifest

```ts
import { defineModule } from "@flexity/core";
import type { ShoptetClient } from "@flexity/shoptet";

export default defineModule<ShoptetClient>({
  name: "low-stock",
  description: "Alerts when a variant drops under its reorder point.",
  migrationsDir: new URL("../migrations/", import.meta.url),
  tasks: {
    check: { description: "Compare stock with reorder points.", run: async (ctx) => check(ctx) },
  },
  tables: [{ name: "low_stock_rules", scope: "data:read", description: "Reorder point per variant code." }],
});
```

Names are kebab-case (module, tasks); table names are plain SQL identifiers.
`defineModule` validates the shape at import time.

### 4. Migrations

- Plain SQL, `NNNN_description.sql`. Applied once, recorded with a sha256.
- Never edit an applied file. Fix forward with a new file.
- Prefix tables with the module name (`low_stock_*`) so modules do not collide.
- Do not insert merchant data (status IDs, store keys, thresholds) in a migration.
  Ship empty rules tables and show an example `insert` in the README.
- A module may read another module's tables (for example the order mirror) but never
  writes to them. Say which tables you read in a comment at the top of the migration.

### 5. Tables and scopes

Every table you list in `tables` becomes queryable through the MCP SQL guard.

- `data:read` for operational data with no personal data (rules, alerts keyed by order
  code, product stats).
- `data:read:customers` for anything with names, e-mails, phones, addresses or free text a
  customer wrote. When in doubt, use the stricter scope.
- Do not list tables that hold secrets or tokens at all.

### 6. Tasks

- `run(ctx)` gets `config`, `db` (null without a database), `shoptet(storeKey)`,
  `notify(channel, text)`, `log`, `now()` and `args` (`--key=value` from the CLI).
- Use `ctx.now()`, never `new Date()`, so tests can freeze time. Use the business-hours
  helpers from `@flexity/core` for SLA math in `config.timezone`.
- Make tasks idempotent: running twice in a row must not double alerts or rows.
- Loop over `ctx.config.stores`, do not assume a store key.
- Return a JSON summary with counts: scanned, matched, notified, skipped. A summary of
  `{ problems: 0 }` without `scanned` hides a partial scan.
- If the task depends on a mirror, check its freshness first and refuse (or warn) when it
  is stale. Alerts from stale data are false alarms.
- Notification failures do not throw (`delivered: false`). Do not mark something as
  "alerted" in the database when it was not delivered.

### 7. Shoptet limits

- Use only the shared client from `ctx.shoptet()`. It enforces 3 concurrent requests,
  backs off on 429 and pages correctly. Never construct a second client for the same token.
- Prefer the mirror or `changeTimeFrom` over full downloads on every run.
- Writes: read the entity back and compare. A 200 is not proof. For MCP write tools,
  follow the two-step preview and `confirm_token` pattern.
- See the `shoptet-api` skill for pagination and timestamp details.

### 8. Tests

- vitest, next to the code. Network is always mocked: pass `fetch` to
  `createShoptetClient` or a fake `shoptet()` in a hand-built `TaskContext`.
- Fixtures are synthetic and obviously fake: `Jane Example`, `jane@shop.example`,
  `https://shop.example`, order codes like `2026000001`, IBAN `CZ00 0000 0000 0000 0000 0000`.
- Never paste real API responses, even "anonymised". Build the smallest object that
  exercises the case.
- Cover: empty store, ignored `itemsPerPage` (10 per page), a 429, stale mirror, task
  run twice, missing Slack webhook.

## PR checklist

- [ ] `npm test`, `npm run typecheck` and `npm run secrets:scan` pass
- [ ] No hardcoded domains, store IDs, status IDs, supplier names or channels
- [ ] Migrations are new files only; tables prefixed; correct scope per table
- [ ] Summary reports scanned counts; idempotent on rerun
- [ ] README: env vars, tasks, example schedule, example rule
- [ ] English everywhere, no em dashes in prose
