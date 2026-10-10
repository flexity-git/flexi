/**
 * Business-hour arithmetic. A business day is a local calendar day (in the given
 * IANA zone) that is Monday to Friday and not a holiday. All of its hours count;
 * there are no office hours. Durations are real elapsed time, so a business day
 * that contains a DST switch counts 23 or 25 hours.
 */

export interface BusinessHoursOptions {
  timeZone: string;
  /** Local dates (`YYYY-MM-DD`) that are not business days, or a predicate over them. */
  holidays?: readonly string[] | ((isoDate: string) => boolean);
}

const HOUR_MS = 3_600_000;
const MAX_DAYS = 3660;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
}

function localDateOf(t: number, timeZone: string): LocalDate {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(t))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return { y: out.year ?? NaN, m: out.month ?? NaN, d: out.day ?? NaN };
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * First instant of the local calendar day. Local date is non-decreasing in time,
 * so a binary search over whole seconds finds the boundary exactly, including
 * days whose midnight falls into a DST gap. Bounds cover every offset (UTC-12 to UTC+14).
 */
function startOfLocalDay(date: LocalDate, timeZone: string): number {
  const wallSeconds = Date.UTC(date.y, date.m - 1, date.d) / 1000;
  let lo = wallSeconds - 15 * 3600; // local date is still the previous day here
  let hi = wallSeconds + 13 * 3600; // local date has reached `date` here
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (compareDates(localDateOf(mid * 1000, timeZone), date) >= 0) hi = mid;
    else lo = mid;
  }
  return hi * 1000;
}

function isoDate(date: LocalDate): string {
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

function isBusinessDate(date: LocalDate, options: BusinessHoursOptions): boolean {
  const weekday = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const { holidays } = options;
  if (!holidays) return true;
  const iso = isoDate(date);
  return typeof holidays === "function" ? !holidays(iso) : !holidays.includes(iso);
}

interface DaySpan {
  start: number;
  end: number;
  business: boolean;
}

function daySpan(t: number, options: BusinessHoursOptions): DaySpan {
  const date = localDateOf(t, options.timeZone);
  return {
    start: startOfLocalDay(date, options.timeZone),
    end: startOfLocalDay(addDays(date, 1), options.timeZone),
    business: isBusinessDate(date, options),
  };
}

/** Is the local day containing `at` a business day? */
export function isBusinessDay(at: Date, options: BusinessHoursOptions): boolean {
  return isBusinessDate(localDateOf(at.getTime(), options.timeZone), options);
}

/**
 * Business hours elapsed between two instants. Negative when `end` is before `start`.
 */
export function businessHoursBetween(start: Date, end: Date, options: BusinessHoursOptions): number {
  const a = start.getTime();
  const b = end.getTime();
  if (b < a) return -businessHoursBetween(end, start, options);
  let total = 0;
  let cursor = a;
  while (cursor < b) {
    const span = daySpan(cursor, options);
    const segmentEnd = Math.min(span.end, b);
    if (span.business) total += segmentEnd - cursor;
    cursor = segmentEnd;
  }
  return total / HOUR_MS;
}

/**
 * The instant that is `hours` business hours after `start` (before it, when
 * negative). Non-business time is skipped. `addBusinessHours(now, -48)` gives the
 * cutoff for "older than 48 business hours".
 */
export function addBusinessHours(start: Date, hours: number, options: BusinessHoursOptions): Date {
  if (!Number.isFinite(hours)) throw new Error("hours must be a finite number");
  let remaining = Math.abs(hours) * HOUR_MS;
  let cursor = start.getTime();
  if (remaining === 0) return new Date(cursor);
  const forward = hours > 0;

  for (let i = 0; i < MAX_DAYS; i++) {
    if (forward) {
      const span = daySpan(cursor, options);
      if (span.business) {
        const available = span.end - cursor;
        if (remaining <= available) return new Date(cursor + remaining);
        remaining -= available;
      }
      cursor = span.end;
    } else {
      // The day that contains the moment just before the cursor.
      const span = daySpan(cursor - 1, options);
      if (span.business) {
        const available = cursor - span.start;
        if (remaining <= available) return new Date(cursor - remaining);
        remaining -= available;
      }
      cursor = span.start;
    }
  }
  throw new Error(`No business day found within ${MAX_DAYS} days. Check the holidays list.`);
}
