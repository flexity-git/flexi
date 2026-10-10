# flexi

**Open-source back-office and AI system for Shoptet e-shops.**

flexi connects your Shoptet stores to Postgres, Slack and Claude. It mirrors orders and
products, tells you when an order is stuck, builds product feeds, and gives Claude safe,
scoped access to your shop data through an MCP server.

It was extracted from the internal system that runs [Flexity](https://www.flexity.sk/): five
Shoptet stores, about 4,500 product variants and more than 14,000 orders a year, operated by a
core team of four. Read the [case study](docs/case-study.md).

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/node-%3E%3D20.19-339933)
![Status: v0.1](https://img.shields.io/badge/status-v0.1-orange)

[Česky](README.cs.md) · [Case study](docs/case-study.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Skills](skills/README.md) · [Contributing](CONTRIBUTING.md)

---

## What works today

| Part | What it does |
|---|---|
| [`@flexity/shoptet`](packages/shoptet) | Shoptet Private API client. Stays within Shoptet's limits (3 concurrent requests per token, waits on 429), retries safely, and never stops paging silently. |
| [`@flexity/mcp`](packages/mcp) | MCP server for Claude Code and Claude Desktop. Live Shoptet tools, read-only SQL over your mirror, per-person tokens with scopes, audit log, preview-then-confirm writes. |
| [`mirror`](modules/mirror) | Copies orders, items, customers, products, variants, categories and statuses of all your stores into Postgres. Compares stores against your primary store. |
| [`stuck-orders`](modules/stuck-orders) | Slack alert when an order sits in a status longer than your rule allows, counted in business hours. Checks the mirror is fresh first, so it does not cry wolf. |
| [`merchant-feed`](modules/merchant-feed) | Google Merchant, Heureka and Zboží.cz feeds from the mirror, with validation, rules and a circuit breaker that keeps the old file when the item count suddenly drops. |
| [Skills](skills) | 8 Claude Code skills with what we learned running Shoptet stores: API pitfalls, stuck order triage, feed checks, multi-store consistency, storefront HTML traps. |

Everything above has tests (400+), runs on Node 20 and Postgres (tested on 17), and needs nothing but
your own Shoptet Private API token. There is no hosted service and no account to create.

## Two-minute start: connect Claude to your store

You need Node 20.19+, a Shoptet store with Private API access (Shoptet admin, Connections,
Private API) and Claude Code.

```sh
git clone https://github.com/flexity-git/flexi.git && cd flexi && npm install

claude mcp add flexi \
  --env FLEXI_STORES=main \
  --env SHOPTET_TOKEN_MAIN=<your token> \
  -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/bin.ts"
```

Then ask Claude something like *"Which orders came in today?"* or *"Show me product
PB-25 with its stock and availability."* These live tools only read. Personal data of
customers stays hidden unless you grant the `data:read:customers` scope.

## Full setup: mirror, alerts and feeds

```sh
cp .env.example .env        # stores, tokens, FLEXI_DATABASE_URL, Slack webhooks
set -a; . ./.env; set +a

npm run flexi -- doctor     # checks config, database and modules; never prints tokens
npm run flexi -- migrate    # creates the tables
npm run flexi -- run mirror:sync-statuses
npm run flexi -- run mirror:sync-products
npm run flexi -- run mirror:sync-orders --since=2026-01-01T00:00:00+0100
npm run flexi -- run stuck-orders:check --dry-run
npm run flexi -- run merchant-feed:generate --feed=google --store=main --out=./feeds/google.xml
```

flexi does not ship a scheduler. Run the tasks from cron, systemd timers, Coolify scheduled
tasks or GitHub Actions. The [`flexi-setup`](skills/flexi-setup/SKILL.md) skill has examples
for each, and Claude can walk you through it.

flexi reads `FLEXI_DATABASE_URL`, never `DATABASE_URL`. Developer shells often export
`DATABASE_URL` for other projects, and flexi must not connect to one of those by accident.

## How it fits together

```
 Shoptet stores ──API──▶ mirror ──▶ Postgres ──▶ stuck-orders ──▶ Slack
   (your tokens)                       │     └──▶ merchant-feed ──▶ feed files
                                       ▼
            Claude ◀──MCP── flexi-mcp (scopes, SQL guard, audit log)
```

Each capability is a module: a folder with SQL migrations, tasks you can run, and a list of
tables it exposes to the MCP server with the scope needed to read them. Adding a carrier, a
bank, a feed format or an alert means adding a module, not changing the core. See
[ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

flexi holds your API tokens and, with the mirror, your customers' data. The defaults are
strict:

- The MCP SQL tool accepts one `SELECT` over allowlisted tables, with an allowlist of plain
  functions, inside a read-only transaction. The guard walks the whole query and rejects
  anything it does not recognise.
- The database is the real boundary: `flexi-mcp db-roles` generates read-only login roles
  that can see only the allowlisted tables, and a separate one for customer data. HTTP mode
  refuses to start without them.
- Database errors are never passed to the caller, only a reference into the audit log.
- Every MCP tool call is written to the audit log, including rejected ones, with e-mails and
  tokens masked.
- HTTP mode needs a bearer token per person. Tokens are stored only as hashes and can be
  revoked.
- Write tools are off by default. When enabled, a change is previewed first and applied only
  with a short-lived confirm token, then read back to verify.
- Module code is loaded only from the project flexi is installed in.

Found a problem? Please report it privately, see [SECURITY.md](SECURITY.md).

## Roadmap

These exist in Flexity's internal system and are candidates for extraction. They are not in
flexi yet.

- Availability rules and a restock date widget for the storefront
- Supplier availability import and purchase order suggestions from sales velocity
- Bank statement pairing (Fio, Barion) with paid status written back to Shoptet
- Shoptet invoices and credit notes
- More feeds (Árukereső, Compari, Ceneje) and comparison site category mapping
- Order status history, for exact time in status
- npm packages, so flexi can be installed without cloning

If you need one of these, open an issue. If you want to build one, even better.

## Contributing

The easiest contribution is a skill: one markdown file with something you learned running a
Shoptet store. Modules, fixes and translations are welcome too. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

flexi is maintained by a small team that also runs a business. Reviews can take a few days,
and small focused pull requests get merged fastest.

## Built by

flexi is built by [Tomáš Sokol](https://www.linkedin.com/in/sokoltomas/), founder of
[Flexity](https://www.flexity.sk/), a Bratislava-based pilates and wellness company. Flexity
sells pilates and wellness equipment through its own Shoptet stores in Slovakia, Czechia,
Hungary, Croatia and Romania, and runs reformer and barre studios in Bratislava and Poprad.

Tomáš is not a full-time developer. He built Flexity's internal system with Claude Code as
his main coding partner, and talks about it at Reshoper 2026 in Prague:
*"Čtyři lidé, práce za čtrnáct: Jak nám AI pomohla postavit vlastní systém"*.

If flexi saves you time, a star helps other Shoptet merchants find it. If you write about it,
see [CITATION.cff](CITATION.cff).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

"Shoptet" is a trademark of its owner. flexi is an independent project and is not affiliated
with or endorsed by Shoptet.
