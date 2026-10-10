---
name: flexi-setup
description: Use when installing or configuring flexi for a Shoptet merchant, when `flexi doctor` reports problems, when scheduling flexi tasks (cron, systemd, Coolify, GitHub Actions), when checking that the first sync really worked, or when connecting the flexi MCP server to Claude Code.
---

# Setting up flexi for a merchant

flexi is self-hosted. The merchant runs it with their own Shoptet Private API token and
their own Postgres. There is no hosted service and no built-in scheduler.

## When to use

- First install on a server or laptop.
- Adding a store, a Slack channel or a module to an existing install.
- "The task ran but nothing happened" or `doctor` shows a problem.

## Steps

### 1. Prerequisites

- Node 20.19 or newer (`.nvmrc`), Postgres 14+ if you want the mirror and alerts.
- A Shoptet plan with the Private API, and one dedicated token per store
  (see the `shoptet-api` skill for token rights).

```sh
git clone https://github.com/flexity-git/flexi.git && cd flexi
npm ci
```

### 2. Environment

The CLI reads only environment variables. It does not load a `.env` file by itself, so
load it in the shell or in the scheduler. `.env` is gitignored; keep it that way.

```sh
FLEXI_STORES=sk,cz
FLEXI_PRIMARY_STORE=sk                # source of truth for multi-store checks
SHOPTET_TOKEN_SK=...                  # never commit, never paste into chat
SHOPTET_TOKEN_CZ=...
SHOPTET_STORE_SK_URL=https://shop.example
FLEXI_DATABASE_URL=postgres://flexi:change-me@localhost:5432/flexi
FLEXI_SLACK_WEBHOOK_ALERTS=...        # optional; missing = log only
FLEXI_SLACK_WEBHOOK_ORDERS=...
FLEXI_TIMEZONE=Europe/Prague
FLEXI_MODULES=mirror,stuck-orders     # optional; order matters for migrations
```

Full list and meaning: `docs/ARCHITECTURE.md#configuration`.

### 3. Doctor, then migrate

```sh
set -a; . ./.env; set +a
npm run flexi -- doctor
npm run flexi -- migrate
npm run flexi -- list
```

Use `--` after `npm run flexi` so npm does not swallow task options like `--store=sk`.
`doctor` must end with `doctor: all good`. It lists every config issue at once and never
prints secret values. `migrate` refuses to run if an already applied file changed; that
is a deliberate stop, never edit an applied migration to get past it.

### 4. First run by hand

```sh
npm run flexi -- run mirror:sync-orders
```

Each run prints one JSON line (`{"ok":true,...,"summary":{...}}`) and exits non-zero on
failure. Task names come from `flexi list`; do not guess them.

### 5. Verify the first sync

Do not trust `ok: true` alone. Check:

```sql
select module, task, status, started_at, finished_at, summary
from flexi_task_runs order by started_at desc limit 5;
```

- Compare the count in the summary with the total in Shoptet admin or with
  `paginator.totalCount` from the API for the same window. A big gap means a pagination
  or token-rights problem, not "the shop is quiet".
- Open two or three recent orders in the admin and compare status and price with the mirror.

### 6. Schedule

Pick one scheduler. Always load the env, run from the repo directory, and prevent overlap.

cron (Linux, `flock` stops a slow run from stacking):

```cron
*/15 * * * * cd /opt/flexi && set -a && . ./.env && set +a && flock -n /tmp/flexi-sync.lock npm run flexi -- run mirror:sync-orders >> /var/log/flexi.log 2>&1
```

systemd (`/etc/systemd/system/flexi-sync.service` + `.timer`):

```ini
[Service]
Type=oneshot
WorkingDirectory=/opt/flexi
EnvironmentFile=/opt/flexi/.env
ExecStart=/usr/bin/npm run flexi -- run mirror:sync-orders

[Timer]
OnCalendar=*:0/15
[Install]
WantedBy=timers.target
```

Coolify: deploy the repo as an application, put the variables in its environment, then add
a Scheduled Task with command `npm run flexi -- run mirror:sync-orders` and frequency
`*/15 * * * *`.

GitHub Actions (only if the database is reachable from GitHub runners; scheduled runs can
start late or be skipped, so do not use it for time-critical alerts):

```yaml
on: { schedule: [{ cron: "*/30 * * * *" }], workflow_dispatch: {} }
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc }
      - run: npm ci
      - run: npm run flexi -- run mirror:sync-orders
        env:
          FLEXI_STORES: sk
          SHOPTET_TOKEN_SK: ${{ secrets.SHOPTET_TOKEN_SK }}
          FLEXI_DATABASE_URL: ${{ secrets.FLEXI_DATABASE_URL }}
```

Schedule checks (stuck orders, feeds) after the sync they read from, and only as often as
the mirror is refreshed. A checker that runs more often than its data refreshes only
repeats stale alerts.

### 7. Connect the MCP server to Claude Code

The package declares a `flexi-mcp` bin (`packages/mcp/src/bin.ts`). Scopes for the stdio
process come from `FLEXI_MCP_SCOPES`; when unset it gets `data:read,shoptet:read` only.
Add `data:read:customers` or `shoptet:write:products` by name, only if this user needs them.

```sh
claude mcp add flexi --scope user \
  -e FLEXI_STORES=sk -e SHOPTET_TOKEN_SK=... -e FLEXI_DATABASE_URL=... \
  -e FLEXI_MCP_SCOPES=data:read,shoptet:read \
  -- /opt/flexi/node_modules/.bin/tsx /opt/flexi/packages/mcp/src/bin.ts
```

Use absolute paths: Claude starts the server from its own working directory, where a
bare `npx tsx` may not resolve. For team access over HTTP with per-person tokens, the
read-only Postgres roles and Claude Desktop config, follow `packages/mcp/README.md`.

Then run `/mcp` in Claude Code and confirm the server is connected. Read the
`mcp-data-safety` skill before querying data.

## Pitfalls

- The database variable is `FLEXI_DATABASE_URL`, not `DATABASE_URL`. Shells and CI often
  export `DATABASE_URL` for other projects, and flexi must never connect to one of those
  silently (and then migrate it). If you copy an old config, rename the variable.
- A missing Slack webhook is not an error: messages go to the log. If nobody reads the
  log, alerts are lost. Configure at least `FLEXI_SLACK_WEBHOOK_ALERTS` in production.
- Two schedulers running the same task (old cron plus new Coolify task) double the API load.
