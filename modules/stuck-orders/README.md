# @flexity/module-stuck-orders

Alerts in Slack when an order sits in a Shoptet status longer than you allow, counted
in business hours (Monday to Friday in `FLEXI_TIMEZONE`, weekends and listed holidays
do not count).

It reads the order mirror maintained by the `mirror` module (`shoptet_orders`,
`shoptet_order_statuses`, `shoptet_sync_state`) and never calls the Shoptet API.

## Setup

1. Install and run the `mirror` module so that `shoptet_orders` is kept in sync.
2. Set `FLEXI_DATABASE_URL` and run `flexi migrate`.
3. Set `FLEXI_SLACK_WEBHOOK_ORDERS` (and `FLEXI_SLACK_WEBHOOK_ALERTS` for the
   stale-mirror warning). Without a webhook the message is only logged, and the
   order is not marked as alerted, so it is reported again on the next run.
4. Insert your rules (see below).
5. Schedule `flexi run stuck-orders:check` from cron, a systemd timer or similar,
   for example every 30 minutes. Run it after the mirror sync, not before.

## Rules

The module ships no rules. Status IDs and names differ per store, so you write your own
into `stuck_order_rules`:

| Column | Meaning |
|---|---|
| `store_key` | Store the rule applies to, or `null` for every configured store. |
| `status_id` | Shoptet status ID to watch. |
| `status_name` | Status name to watch, compared case-insensitively. A rule matches on either `status_id` or `status_name`; at least one must be set. |
| `max_business_hours` | How long an order may stay in the status. |
| `channel` | Slack channel: `orders` (default), `alerts` or `products`. |
| `enabled` | Disabled rules are ignored, and their open alerts are resolved. |
| `note` | Free text for yourself. |

Example only, adjust the names and limits to your store:

```sql
-- Example: any store, orders still "Vyřizuje se" after 24 business hours.
insert into stuck_order_rules (store_key, status_name, max_business_hours, note)
values (null, 'Vyřizuje se', 24, 'example: order not handled within one business day');

-- Example: one store, a status by its ID, reported to the alerts channel.
insert into stuck_order_rules (store_key, status_id, max_business_hours, channel)
values ('sk', -1, 48, 'alerts');  -- replace -1 with a real status ID from shoptet_order_statuses
```

Look up your status IDs and names with:

```sql
select store_key, id, name from shoptet_order_statuses order by store_key, id;
```

## Tasks

### `stuck-orders:check`

1. **Freshness guard.** For each configured store it reads
   `shoptet_sync_state.last_success_at` for resource `orders`. A store whose mirror is
   older than `--max-mirror-age-hours` (or was never synced) is skipped, and one message
   to the `alerts` channel says so. A stale mirror would otherwise look like a flood of
   stuck orders.
2. Evaluates every enabled rule against orders of the fresh stores created within
   `--lookback-days`.
3. Sends one message per channel listing the due orders (store key, code, status, age
   in business hours, limit), capped at `--max-lines` with "+N more".
4. Records each announced order in `stuck_order_alerts`. An order is announced once
   per rule and reminded again only after `--cooldown-hours`.
5. Resolves open alerts whose order no longer matches the rule.

| Option | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Return the messages in the summary instead of sending them. Writes nothing. |
| `--cooldown-hours` | 24 | Wall-clock hours before a still-stuck order is reminded again. |
| `--max-mirror-age-hours` | 3 | Older mirror = store is skipped. |
| `--lookback-days` | 30 | Only orders created within this window are checked. |
| `--max-lines` | 20 | Orders listed per message before "+N more". |
| `--holidays` | none | Comma-separated local dates that are not business days, e.g. `2026-12-24,2026-12-25`. |

### `stuck-orders:report`

Returns how many orders are currently over a rule threshold, per store and status. It
never notifies and never writes.

## How the age is measured

The mirror keeps no status history, so the module uses the order's `change_time` (last
change in Shoptet) as the moment it entered its current status. Any later edit of the
order resets that clock, so the age can be underestimated, never overestimated: the
module may alert late, but not falsely.

## Tables

| Table | MCP scope | Content |
|---|---|---|
| `stuck_order_rules` | `data:read` | Your rules. |
| `stuck_order_alerts` | `data:read` | One row per announced order and rule: first and last alert, count, `resolved_at`. |
