import { randomBytes } from "node:crypto";
import { ShoptetApiError, ShoptetNetworkError } from "@flexity/shoptet";

/**
 * An error whose message was written by this package for the caller and holds
 * no data from the database or the Shoptet API. Only these (and guard
 * rejections) are returned verbatim from a tool call.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Short id that links a generic error shown to the caller with its audit row. */
export function newErrorRef(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The message a caller may see. Database and unexpected errors are replaced by
 * a generic text with a reference: Postgres error text can carry row values
 * (e.g. "invalid input syntax for type integer: <value>").
 */
export function publicErrorMessage(err: unknown, ref: string, safe: (err: unknown) => boolean): string {
  if (safe(err)) return (err as Error).message;
  if (err instanceof ShoptetApiError) {
    const codes = err.errorCodes.length > 0 ? ` (${err.errorCodes.join(", ")})` : "";
    return `Shoptet API returned HTTP ${err.status}${codes}. Reference ${ref}.`;
  }
  if (err instanceof ShoptetNetworkError) return `Shoptet API could not be reached. Reference ${ref}.`;
  return `The tool failed. Reference ${ref}; the details are in the audit log.`;
}
