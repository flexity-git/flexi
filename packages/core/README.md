# @flexity/core

Shared building blocks for flexi: configuration, Postgres access, SQL migrations,
the module contract, a Slack notifier, a JSON logger and business-hour math.

```ts
import { loadConfig, getPool, createNotifier, defineModule, addBusinessHours } from "@flexity/core";

const config = loadConfig(); // reads and validates process.env
const notifier = createNotifier(config);
await notifier.notify("alerts", "Order sync is late");
```

## What is in here

- `loadConfig(env)` validates the variables listed in `docs/ARCHITECTURE.md` and throws a
  `ConfigError` that names every missing or invalid variable. Values are never echoed.
  `redactConfig(config)` gives a copy that is safe to print.
- `getPool(config)` returns a lazy, shared `pg.Pool` per connection string. `closePool()` ends them.
- `runMigrations({ pool, sources })` applies `NNNN_description.sql` files per source in order.
  Each file runs in its own transaction, the whole run holds a Postgres advisory lock, and
  applied files are recorded in `flexi_migrations (module, filename, sha256, applied_at)`.
  Editing an applied file is an error. The runner creates `flexi_migrations` itself before
  applying anything; `migrations/0001_core.sql` creates `flexi_task_runs`.
- `defineModule()` validates a module manifest. Types: `FlexiModule`, `TaskContext`,
  `TaskDefinition`, `TableExposure`.
- `createNotifier(config)` posts to the webhook of a logical channel (`alerts`, `orders`,
  `products`). Without a webhook it logs. It never throws.
- `createLogger()` / `log` write one JSON object per line to stderr.
- `addBusinessHours(start, hours, { timeZone, holidays })` and `businessHoursBetween(a, b, opts)`
  count weekdays in full in the given zone and skip weekends and optional holidays.
  Negative hours go backwards. DST switches count as real elapsed time.

## Typed Shoptet client in tasks

`TaskContext.shoptet(storeKey)` returns an opaque object by default, so core has no
dependency on the client package. Pass the real type when you define a module:

```ts
import type { ShoptetClient } from "@flexity/shoptet";
export default defineModule<ShoptetClient>({ /* ... */ });
```

## Tests

`npx vitest run packages/core`. The Postgres integration test runs only when
`FLEXI_DATABASE_URL_TEST` points at a throwaway database; it works inside a temporary schema.
