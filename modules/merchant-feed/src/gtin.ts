const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** Strips spaces and hyphens that merchants often type into EAN fields. */
export function normalizeGtin(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s-]/g, "");
}

/**
 * True for a GTIN-8, -12 (UPC-A), -13 (EAN) or -14 with a correct check digit.
 * The check digit uses the GS1 mod-10 algorithm: from the right, excluding the
 * check digit itself, digits are weighted 3, 1, 3, 1, ...
 */
export function isValidGtin(value: string | null | undefined): boolean {
  const gtin = normalizeGtin(value);
  if (!/^\d+$/.test(gtin) || !GTIN_LENGTHS.has(gtin.length)) return false;
  if (/^0+$/.test(gtin)) return false;
  const digits = [...gtin].map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = digits[digits.length - 1 - i]!;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}
