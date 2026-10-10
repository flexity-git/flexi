# Architecture

flexi is a TypeScript monorepo (npm workspaces, Node 20+, ESM). Every merchant runs it
themselves with their own Shoptet Private API token. There is no hosted service.

```
packages/
  shoptet/   @flexity/shoptet  Shoptet Private API client. No dependency on the rest of flexi.
  core/      @flexity/core     Config, Postgres, migrations, module contract, Slack notifier, logger.
  cli/       @flexity/cli      `flexi` binary: migrate, run, list, doctor.
  mcp/       @flexity/mcp      MCP server: live Shoptet tools + scoped SQL over the local mirror.
modules/
  <name>/    @flexity/module-<name>  One business capability. Depends on core + shoptet.
skills/      Claude Code skills (one folder, one SKILL.md each).
.claude-plugin/  Claude Code plugin + marketplace manifest.
```

## Configuration

All configuration comes from environment variables, validated with zod in `@flexity/core`.

| Variable | Meaning |
|---|---|
| `FLEXI_STORES` | Comma-separated store keys, e.g. `sk,cz`. Keys are lowercase, chosen by the merchant. |
| `SHOPTET_TOKEN_<KEY>` | Private API token for that store, e.g. `SHOPTET_TOKEN_SK`. |
| `SHOPTET_STORE_<KEY>_URL` | Optional public URL of the store (used in feeds and links). |
| `FLEXI_PRIMARY_STORE` | Optional. Store treated as source of truth for multi-store comparisons. Defaults to the first key. |
| `FLEXI_DATABASE_URL` | Postgres connection string. Optional for live-only MCP use. |
| `FLEXI_SLACK_WEBHOOK_<CHANNEL>` | Incoming webhook per logical channel (`ALERTS`, `ORDERS`, `PRODUCTS`). Missing webhook = the notifier logs instead of sending. |
| `FLEXI_TIMEZONE` | IANA zone for business-day math. Default `Europe/Prague`. |
| `FLEXI_MODULES` | Comma-separated enabled modules. Default: all installed. |

Nothing about a specific merchant (domains, status IDs, store IDs, channel names) may be
hardcoded. If a module needs it, it reads it from env or from a table.

## Module contract

A module exports a manifest as the default export of `src/index.ts`:

```ts
import { defineModule } from "@flexity/core";

export default defineModule({
  name: "stuck-orders",              // kebab-case, unique
  description: "Alerts when orders sit in a status too long.",
  migrationsDir: new URL("../migrations", import.meta.url),
  tasks: {
    check: { description: "...", run: async (ctx) => { /* ... */ } },
  },
  tables: [                           // exposed to MCP SQL, with required scope
    { name: "stuck_order_alerts", scope: "data:read", description: "..." },
  ],
});
```

- `ctx` (`TaskContext`) gives `config`, `db` (pg Pool or null), `shoptet(storeKey)` client
  factory, `notify(channel, message)`, `log`, `now()` and `args`.
- Tasks are run by `flexi run <module>:<task>` from cron, systemd timers, Coolify scheduled
  tasks or GitHub Actions. flexi does not ship a scheduler.
- Module discovery: the CLI imports installed workspace packages named `@flexity/module-*`.

## Migrations

Plain SQL files, `NNNN_description.sql`, in `packages/core/migrations` and in each module's
`migrations/`. The runner applies core first, then modules in `FLEXI_MODULES` order, and
records `(module, filename, sha256)` in `flexi_migrations`. A changed file that was already
applied is an error, never a silent re-run.

## Shoptet API rules

- Respect Shoptet's documented limits: at most 3 concurrent requests per token, back off on
  HTTP 429 using `Retry-After`, retry 423/5xx with jitter.
- List endpoints: always pass `itemsPerPage` where the endpoint supports it, and never trust it
  was honoured. Loop on `paginator.pageCount`, and never stop silently at a page cap: if a cap
  is hit, throw or report it.
- Prefer incremental sync (`changeTimeFrom`) and webhooks over full re-downloads.
- Do not copy Shoptet documentation text into this repo. Link to developers.shoptet.com.

## Security rules

- No secrets, real customer data, real IBANs, real store IDs or real supplier names anywhere,
  including tests and fixtures. Fixtures are synthetic and obviously fake
  (`Jane Example`, `shop.example`, `CZ00 0000 ...`).
- MCP SQL runs through a guard (SELECT only, allowlisted tables, scope per table) and every
  query is written to an audit log.
- Write tools are two-step: a call without `confirm_token` returns a preview; only a second
  call with the token from that preview changes anything.

## Code conventions

- TypeScript strict, ESM, `.js` suffix in relative imports (NodeNext).
- Tests next to code (`*.test.ts`), vitest. Network is always mocked in unit tests.
- English for code, comments, logs, tool descriptions and docs. Czech only in `README.cs.md`
  and `docs/cs/`.
- No em dashes in prose.
