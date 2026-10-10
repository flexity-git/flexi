---
name: shoptet-stuck-orders-triage
description: Use when an order (or a batch of orders) seems stuck in a Shoptet status, when a stuck-orders alert fires, or when a customer asks where their order is. Covers checking mirror freshness first, confirming against the live API, the usual causes, and what to tell the customer without promising unconfirmed dates.
---

# Triage of stuck Shoptet orders

An order is "stuck" when it stays in one status longer than the merchant's rule allows
(for example "paid, not shipped after 16 business hours"). Most alerts have a boring cause.
Some are false alarms from stale data. Find out which before anyone writes to a customer.

## When to use

- A stuck-orders alert arrived (Slack or log).
- Support asks "why has order 2026000123 not shipped?".
- A morning report shows many orders stuck at once.

## Steps

### 1. Check that the data is fresh

A stale mirror produces false alarms: the order moved on hours ago, but the mirror still
shows the old status. Always check this first.

- Find when the order mirror last synced successfully. In flexi look at the mirror
  module's `shoptet_sync_state` and at `flexi_task_runs` for the sync task (confirm the
  columns with `schema_describe`, the mirror module is young).
- If the last successful sync is older than the sync interval plus a margin, stop.
  Report "mirror is stale since <time>", fix the sync, rerun, then re-check alerts.
- Many orders "stuck" at the same moment, across unrelated statuses, is almost always a
  stale mirror or a sync that failed, not many real problems.
- Morning alerts deserve extra suspicion: a checker scheduled before the first sync of
  the day reads yesterday's data.

### 2. Confirm against the live API

For each order still flagged, read it live (`getOrder(code)` or the MCP live tool):
current status, `changeTime`, `paid`, shipping and payment method. If live differs from
the mirror, the alert is a sync problem, not an order problem.

Remember the order code is unique per store, not across stores. Always carry the store key.

### 3. Find the cause

Work through these in order. Check, do not assume.

| Symptom | Typical cause | Where to look |
|---|---|---|
| Waiting for payment, customer says they paid | Bank transfer not paired (wrong variable symbol, amount differs, paid to another store's account) | Bank statement vs. order total and variable symbol |
| Paid, not shipped | Carrier label not created, or created with an error (bad address, missing phone, parcel too heavy for the service) | Carrier integration log, label status |
| Paid, not shipped, label fine | Item out of stock or reserved for another order | Stock per variant code, purchase orders |
| Supplier dropship or preorder | Supplier delay | Supplier confirmation, not the expected date in your own notes |
| Status unchanged, everything done | Someone forgot to move the status, or an automation that moves it failed | Shoptet admin history of the order |
| Cancelled or returned but still flagged | Rule matches a status it should not | The stuck-orders rule itself |

### 4. Decide and record

- Fix the cause, or hand it to the person who can (warehouse, accounting, supplier contact).
- If the rule is wrong (too strict, wrong status), change the rule instead of muting alerts.
- Write a short note on the order in the admin so the next person does not redo the triage.

### 5. Tell the customer (draft only, a human sends it)

- Say what is true now: "your order is paid and waiting for item X to arrive from our supplier".
- Never promise a date that nobody has confirmed. "Expected next week" from a supplier
  e-mail is not a confirmation. Use "as soon as we have a confirmed date, we will write to
  you" instead.
- Offer a real option when one exists: ship the available items now, swap a variant,
  cancel with a refund. Do not invent options the shop does not offer.
- Do not quote internal notes, supplier names or other customers' orders.

## Pitfalls

- Trusting the alert without step 1. Stale mirror alerts teach the team to ignore alerts.
- Counting business hours across a weekend or holiday wrong. Use `FLEXI_TIMEZONE` and the
  business-hours helpers, not wall-clock hours.
- Reading customer data you do not need. For triage, the order code, status, items and
  shipping method are usually enough; personal data needs the customers scope.

## Example

Alert: 14 orders stuck in "Paid" on store `sk` at 07:05.
Mirror last synced at 23:50 the previous day (nightly sync failed). Live API shows 12 of
them already "Shipped". After rerunning the sync, two remain: one has a label error
(missing phone), one waits for an out-of-stock variant. Draft for Jane Example: "Your
order is paid. One item is not in stock yet; we will write as soon as we have a confirmed
delivery date, or we can ship the rest now if you prefer."
