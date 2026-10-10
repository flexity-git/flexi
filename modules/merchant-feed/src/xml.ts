// XML 1.0 allows only tab, LF and CR among the C0 control characters. Text pasted
// from office documents sometimes carries others, which makes the file invalid.
const XML_INVALID_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g;

/** Escapes text for use in element content or attribute values. */
export function xmlEscape(value: string): string {
  return value
    .replace(XML_INVALID_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** `<tag>value</tag>` with escaping, or null for an empty value so callers can filter it out. */
export function element(tag: string, value: string | number | undefined | null, indent: string): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text === "") return null;
  return `${indent}<${tag}>${xmlEscape(text)}</${tag}>`;
}

/** Price with two decimals and a dot, no currency. */
export function formatPrice(value: number): string {
  return value.toFixed(2);
}
