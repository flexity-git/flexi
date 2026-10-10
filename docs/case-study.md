# Case study: four people, five Shoptet stores

flexi was extracted from the internal system that Flexity, a pilates and wellness company
from Bratislava, uses to run its e-commerce. This page explains what that system does today and
why it was built. The numbers are from October 2026.

## The starting point

Flexity sells pilates equipment, wellness and biohacking products on five Shoptet stores:
Slovakia, Czechia, Hungary, Croatia and Romania, plus a smaller English store. Each store has
its own language, currency and pricing. Next to that, the company runs reformer and barre
studios in Bratislava and Poprad.

The core team is four people. Revenue is about 2.3 million euros a year.

| What | Size |
|---|---|
| Shoptet stores | 5, plus one English store |
| Catalog | about 1,900 products and 4,500 variants, in five languages |
| Orders | more than 14,100 in the last 12 months |
| Active suppliers | 41, of which 9 send stock availability automatically |
| Availability updates | about 1,000 per day |
| Purchase orders | 455 in six months |
| Product feeds | 10 Google feeds, plus price comparison sites |

Shoptet handles the storefront, checkout and order administration well. What it does not do is
connect five stores to each other, to suppliers, to the bank and to the warehouse. That work
used to be manual: spreadsheets, copied prices, and checking orders by hand.

## What we built

Since March 2026 the owner, Tomáš Sokol, has been building an internal system with Claude Code
as the main coding partner. He is not a full-time developer. By October it had about 210
database tables and around 60 services and scheduled jobs. The parts that matter most:

- **One mirror of all five stores.** Orders, products, variants and categories are synced from
  the Shoptet API into Postgres on a schedule. Every other feature reads from there instead of
  calling the API again.
- **Alerts instead of checking.** Orders that sit in one status too long show up in Slack with
  their age in business hours. Before alerting, the check confirms the mirror is fresh, because
  a stale mirror produces false alarms. We learned that from a 7 a.m. alarm that was wrong.
- **Feeds built from the mirror.** Google and comparison site feeds are generated from one
  catalog, validated before publishing, and not overwritten when the item count suddenly drops.
- **Supplier availability and purchasing.** Supplier stock comes in daily and drives
  availability on all five stores. Purchase orders are prepared from sales velocity across all
  stores, because everything ships from one warehouse.
- **Invoice control for the warehouse partner.** Every invoice line is checked against the
  agreed price list before it is paid.
- **An MCP server for the whole team.** Each person has a token with specific scopes. Claude
  can query the data (read-only, with an audit log) and propose changes, but a change only
  happens after a preview and a human confirmation.

## How the team uses it

The system is not only the owner's tool. People in operations and marketing use Claude with the
MCP server in their own work. One example: a colleague from operations noticed that purchase
orders needed a "price quote" state while waiting for a supplier's offer. They wrote a short
brief in Slack. A week later the state was in production.

That loop, where the person closest to the problem writes the brief and AI does most of the
build, is the main reason four people can run this much.

## What is in flexi

flexi is the part of this system that any Shoptet merchant can use: the Shoptet API client, the
store mirror, stuck order alerts, product feeds, the MCP server and Claude Code skills. Supplier
specific code, scrapers, and anything that touches our partners' systems stayed private.

See the [README](../README.md) for what works today and what is on the roadmap.

## About

Tomáš Sokol is the founder of Flexity, a Bratislava-based pilates and wellness company, and the
author of flexi, an open-source back-office for Shoptet merchants.

- LinkedIn: https://www.linkedin.com/in/sokoltomas/
- Flexity: https://www.flexity.sk/
- Talk: "Čtyři lidé, práce za čtrnáct: Jak nám AI pomohla postavit vlastní systém",
  Reshoper 2026, Prague, 15 October 2026.
