import { SLACK_CHANNELS, type SlackChannel } from "@flexity/core";
import type { MirrorOrder, OpenAlert, StuckHit, StuckRule, SyncStateRow } from "./evaluate.js";

/** The part of pg.Pool / pg.PoolClient this module uses. Kept small so tests can fake it. */
export interface Queryable {
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toChannel(value: unknown): SlackChannel {
  return (SLACK_CHANNELS as readonly string[]).includes(String(value)) ? (value as SlackChannel) : "orders";
}

/** Last successful orders sync per store, as recorded by the mirror module. */
export async function loadSyncState(db: Queryable, storeKeys: readonly string[]): Promise<SyncStateRow[]> {
  const { rows } = await db.query<{ store_key: string; last_success_at: Date | null }>(
    `select store_key, last_success_at
       from shoptet_sync_state
      where resource = 'orders'
        and store_key = any($1::text[])`,
    [storeKeys],
  );
  return rows.map((r) => ({ storeKey: r.store_key, lastSuccessAt: r.last_success_at ? toDate(r.last_success_at) : null }));
}

export async function loadEnabledRules(db: Queryable): Promise<StuckRule[]> {
  const { rows } = await db.query<{
    id: string | number;
    store_key: string | null;
    status_id: number | null;
    status_name: string | null;
    max_business_hours: string | number;
    channel: string;
    note: string | null;
  }>(
    `select id, store_key, status_id, status_name, max_business_hours, channel, note
       from stuck_order_rules
      where enabled
      order by id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    storeKey: r.store_key,
    statusId: r.status_id === null ? null : Number(r.status_id),
    statusName: r.status_name,
    maxBusinessHours: Number(r.max_business_hours),
    channel: toChannel(r.channel),
    note: r.note,
  }));
}

/**
 * Orders of the given stores that sit in a status some rule watches, created
 * after `createdAfter`. The status name falls back to the status table when the
 * order row has none.
 */
export async function loadCandidateOrders(
  db: Queryable,
  storeKeys: readonly string[],
  rules: readonly StuckRule[],
  createdAfter: Date,
): Promise<MirrorOrder[]> {
  const ids = [...new Set(rules.flatMap((r) => (r.statusId === null ? [] : [r.statusId])))];
  const names = [...new Set(rules.flatMap((r) => (r.statusName?.trim() ? [r.statusName.trim().toLowerCase()] : [])))];
  if (storeKeys.length === 0 || (ids.length === 0 && names.length === 0)) return [];
  const { rows } = await db.query<{
    store_key: string;
    code: string;
    status_id: number | null;
    status_name: string | null;
    creation_time: Date;
    change_time: Date | null;
  }>(
    `select o.store_key, o.code, o.status_id,
            coalesce(o.status_name, s.name) as status_name,
            o.creation_time, o.change_time
       from shoptet_orders o
       left join shoptet_order_statuses s
         on s.store_key = o.store_key and s.id = o.status_id
      where o.store_key = any($1::text[])
        and o.creation_time >= $4
        and (o.status_id = any($2::int[])
             or lower(trim(coalesce(o.status_name, s.name))) = any($3::text[]))`,
    [storeKeys, ids, names, createdAfter],
  );
  return rows.map((r) => ({
    storeKey: r.store_key,
    code: r.code,
    statusId: r.status_id === null ? null : Number(r.status_id),
    statusName: r.status_name,
    creationTime: toDate(r.creation_time),
    // An order never changed since creation has entered its status at creation.
    changeTime: toDate(r.change_time ?? r.creation_time),
  }));
}

export async function loadOpenAlerts(db: Queryable): Promise<OpenAlert[]> {
  const { rows } = await db.query<{
    id: string | number;
    store_key: string;
    order_code: string;
    rule_id: string | number;
    first_alerted_at: Date;
    last_alerted_at: Date;
    alert_count: number;
  }>(
    `select id, store_key, order_code, rule_id, first_alerted_at, last_alerted_at, alert_count
       from stuck_order_alerts
      where resolved_at is null`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    storeKey: r.store_key,
    orderCode: r.order_code,
    ruleId: Number(r.rule_id),
    firstAlertedAt: toDate(r.first_alerted_at),
    lastAlertedAt: toDate(r.last_alerted_at),
    alertCount: Number(r.alert_count),
  }));
}

/** Records that these hits were announced at `at`: opens a new alert or bumps the open one. */
export async function markAlerted(db: Queryable, hits: readonly StuckHit[], at: Date): Promise<void> {
  if (hits.length === 0) return;
  await db.query(
    `insert into stuck_order_alerts (store_key, order_code, rule_id, first_alerted_at, last_alerted_at, alert_count)
     select t.store_key, t.order_code, t.rule_id, $4, $4, 1
       from unnest($1::text[], $2::text[], $3::bigint[]) as t(store_key, order_code, rule_id)
     on conflict (store_key, order_code, rule_id) where resolved_at is null
     do update set last_alerted_at = excluded.last_alerted_at,
                   alert_count = stuck_order_alerts.alert_count + 1`,
    [hits.map((h) => h.order.storeKey), hits.map((h) => h.order.code), hits.map((h) => h.rule.id), at],
  );
}

export async function markResolved(db: Queryable, alerts: readonly OpenAlert[], at: Date): Promise<void> {
  if (alerts.length === 0) return;
  await db.query(
    `update stuck_order_alerts
        set resolved_at = $2
      where id = any($1::bigint[])
        and resolved_at is null`,
    [alerts.map((a) => a.id), at],
  );
}
