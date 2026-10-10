/** Default zone for Shoptet timestamps. Shoptet stores run on Central European time. */
export const DEFAULT_SHOPTET_TIME_ZONE = "Europe/Prague";

/**
 * Format a date the way Shoptet filters expect it: second precision with a
 * numeric offset and no colon, e.g. `2026-03-01T10:15:00+0100`.
 * A `Z` suffix or milliseconds are not used because Shoptet rejects them.
 */
export function toShoptetTimestamp(
  input: Date | string | number,
  timeZone: string = DEFAULT_SHOPTET_TIME_ZONE,
): string {
  const d = new Date(input instanceof Date ? input.getTime() : input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`toShoptetTimestamp: invalid date ${String(input)}`);
  }
  d.setUTCMilliseconds(0);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  // The wall-clock time read back as UTC minus the real instant is the offset.
  const offsetMinutes = Math.round((Date.parse(`${local}Z`) - d.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return `${local}${offset}`;
}

/**
 * Parse a Shoptet timestamp such as `2026-03-01T10:15:00+0100` into a Date.
 * Accepts offsets with or without a colon. Throws on invalid input.
 */
export function parseShoptetTimestamp(value: string): Date {
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    throw new RangeError(`parseShoptetTimestamp: invalid timestamp ${value}`);
  }
  return new Date(ms);
}
