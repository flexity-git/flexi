/**
 * Pure logic for the stuck-orders module: mirror freshness, rule matching,
 * thresholds in business hours, alert dedup and cooldown, resolution and the
 * Slack message text. No I/O here, so all of it is testable without Postgres
 * or Slack.
 */
import { businessHoursBetween, type BusinessHoursOptions, type SlackChannel } from "@flexity/core";

export interface StuckRule {
  id: number;
  /** null = every store. */
  storeKey: string | null;
  statusId: number | null;
  statusName: string | null;
  maxBusinessHours: number;
  channel: SlackChannel;
  note: string | null;
}

export interface MirrorOrder {
  storeKey: string;
  code: string;
  statusId: number | null;
  statusName: string | null;
  creationTime: Date;
  /**
   * Last change of the order in Shoptet. Used as the time the order entered its
   * current status: the mirror keeps no status history, and any later change
   * resets it, so the age is an underestimate, never an overestimate.
   */
  changeTime: Date;
}

export interface OpenAlert {
  id: number;
  storeKey: string;
  orderCode: string;
  ruleId: number;
  firstAlertedAt: Date;
  lastAlertedAt: Date;
  alertCount: number;
}

export interface StuckHit {
  rule: StuckRule;
  order: MirrorOrder;
  ageBusinessHours: number;
  /** Open alert for this order and rule, if it was already announced. */
  openAlert: OpenAlert | null;
}

export interface Evaluation {
  /** Over the threshold, matching a rule (announced or not). */
  stuck: StuckHit[];
  /** Subset of `stuck` to announce now: never announced, or cooldown elapsed. */
  due: StuckHit[];
  /** Open alerts whose order no longer matches the rule. */
  resolve: OpenAlert[];
}

export interface EvaluateInput {
  rules: readonly StuckRule[];
  orders: readonly MirrorOrder[];
  openAlerts: readonly OpenAlert[];
  now: Date;
  businessHours: BusinessHoursOptions;
  cooldownHours: number;
  /** Stores whose mirror was fresh. Alerts for other stores are left untouched. */
  checkedStores: readonly string[];
}

const HOUR_MS = 3_600_000;

function normName(name: string | null): string | null {
  const trimmed = name?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Does the order sit in the status the rule watches (store and status)? Ignores the threshold. */
export function ruleMatchesOrder(rule: StuckRule, order: MirrorOrder): boolean {
  if (rule.storeKey !== null && rule.storeKey !== order.storeKey) return false;
  const byId = rule.statusId !== null && order.statusId !== null && rule.statusId === order.statusId;
  const ruleName = normName(rule.statusName);
  const byName = ruleName !== null && ruleName === normName(order.statusName);
  return byId || byName;
}

export function alertKey(storeKey: string, orderCode: string, ruleId: number): string {
  return `${storeKey}\u0000${orderCode}\u0000${ruleId}`;
}

/**
 * Evaluates every rule against every order:
 * - an order is stuck when it matches a rule and has been in the status for more
 *   than `maxBusinessHours` business hours (weekends and holidays do not count);
 * - a stuck order is due when it has no open alert, or its last alert is at least
 *   `cooldownHours` (wall-clock) old;
 * - an open alert is resolved when its order no longer matches its rule. Alerts
 *   of stores that were not checked (stale mirror) are never resolved.
 */
export function evaluate(input: EvaluateInput): Evaluation {
  const { rules, orders, openAlerts, now, businessHours, cooldownHours } = input;
  const checked = new Set(input.checkedStores);
  const openByKey = new Map(openAlerts.map((a) => [alertKey(a.storeKey, a.orderCode, a.ruleId), a]));
  const matchedKeys = new Set<string>();
  const stuck: StuckHit[] = [];
  const due: StuckHit[] = [];
  const cooldownCutoff = now.getTime() - cooldownHours * HOUR_MS;

  for (const order of orders) {
    if (!checked.has(order.storeKey)) continue;
    for (const rule of rules) {
      if (!ruleMatchesOrder(rule, order)) continue;
      const key = alertKey(order.storeKey, order.code, rule.id);
      matchedKeys.add(key);
      const ageBusinessHours = businessHoursBetween(order.changeTime, now, businessHours);
      if (ageBusinessHours <= rule.maxBusinessHours) continue;
      const openAlert = openByKey.get(key) ?? null;
      const hit: StuckHit = { rule, order, ageBusinessHours, openAlert };
      stuck.push(hit);
      if (openAlert === null || openAlert.lastAlertedAt.getTime() <= cooldownCutoff) due.push(hit);
    }
  }

  const resolve = openAlerts.filter(
    (a) => checked.has(a.storeKey) && !matchedKeys.has(alertKey(a.storeKey, a.orderCode, a.ruleId)),
  );

  const byAge = (a: StuckHit, b: StuckHit) =>
    b.ageBusinessHours - a.ageBusinessHours || a.order.storeKey.localeCompare(b.order.storeKey) || a.order.code.localeCompare(b.order.code);
  return { stuck: stuck.sort(byAge), due: due.sort(byAge), resolve };
}

export interface SyncStateRow {
  storeKey: string;
  lastSuccessAt: Date | null;
}

export interface StaleStore {
  storeKey: string;
  /** null = the orders resource was never synced successfully. */
  lastSuccessAt: Date | null;
}

/** Stores whose last successful orders sync is missing or older than `maxAgeHours`. */
export function findStaleStores(
  storeKeys: readonly string[],
  syncState: readonly SyncStateRow[],
  now: Date,
  maxAgeHours: number,
): StaleStore[] {
  const lastByStore = new Map(syncState.map((s) => [s.storeKey, s.lastSuccessAt]));
  const cutoff = now.getTime() - maxAgeHours * HOUR_MS;
  return storeKeys
    .map((storeKey) => ({ storeKey, lastSuccessAt: lastByStore.get(storeKey) ?? null }))
    .filter((s) => s.lastSuccessAt === null || s.lastSuccessAt.getTime() < cutoff);
}

function formatHours(hours: number): string {
  return hours.toFixed(1);
}

export function buildStaleMessage(stale: readonly StaleStore[], now: Date, maxAgeHours: number, allStale: boolean): string {
  const lines = stale.map((s) => {
    if (s.lastSuccessAt === null) return `• ${s.storeKey}: no successful orders sync recorded`;
    const age = (now.getTime() - s.lastSuccessAt.getTime()) / HOUR_MS;
    return `• ${s.storeKey}: last successful orders sync ${s.lastSuccessAt.toISOString()} (${formatHours(age)} h ago)`;
  });
  const scope = allStale ? "Skipping the stuck-order check" : "Skipping the stuck-order check for these stores";
  return [
    `Order mirror is stale (older than ${maxAgeHours} h). ${scope} to avoid false alerts.`,
    ...lines,
    "Check the mirror module's orders sync (shoptet_sync_state.last_error).",
  ].join("\n");
}

/** Groups due hits by Slack channel, keeping the evaluation order. */
export function groupByChannel(hits: readonly StuckHit[]): Map<SlackChannel, StuckHit[]> {
  const groups = new Map<SlackChannel, StuckHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.rule.channel) ?? [];
    list.push(hit);
    groups.set(hit.rule.channel, list);
  }
  return groups;
}

function hitLine(hit: StuckHit): string {
  const status = hit.order.statusName ?? (hit.order.statusId !== null ? `status ${hit.order.statusId}` : "unknown status");
  const reminder = hit.openAlert ? " (reminder)" : "";
  return `• ${hit.order.storeKey} ${hit.order.code}: ${status}, ${formatHours(hit.ageBusinessHours)} business h (limit ${hit.rule.maxBusinessHours})${reminder}`;
}

/** One message per channel. Lists at most `maxLines` orders, then "+N more". */
export function buildStuckMessage(hits: readonly StuckHit[], maxLines: number): string {
  const lines = hits.slice(0, maxLines).map(hitLine);
  const rest = hits.length - lines.length;
  if (rest > 0) lines.push(`+${rest} more`);
  const noun = hits.length === 1 ? "order has" : "orders have";
  return [
    `${hits.length} ${noun} been in a status longer than its rule allows:`,
    ...lines,
    "Ages are business hours since the order's last change in Shoptet. Each order is reminded again after the cooldown until it leaves the status.",
  ].join("\n");
}

export interface StuckCount {
  storeKey: string;
  status: string;
  count: number;
}

/** Counts stuck orders per store and status. An order matching two rules counts once. */
export function countStuck(hits: readonly StuckHit[]): StuckCount[] {
  const seen = new Set<string>();
  const counts = new Map<string, StuckCount>();
  for (const hit of hits) {
    const orderKey = `${hit.order.storeKey}\u0000${hit.order.code}`;
    if (seen.has(orderKey)) continue;
    seen.add(orderKey);
    const status = hit.order.statusName ?? String(hit.order.statusId ?? "unknown");
    const key = `${hit.order.storeKey}\u0000${status}`;
    const entry = counts.get(key) ?? { storeKey: hit.order.storeKey, status, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => a.storeKey.localeCompare(b.storeKey) || b.count - a.count);
}
