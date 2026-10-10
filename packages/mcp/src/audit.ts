import type { Logger } from "@flexity/core";
import type { Queryable } from "./db-types.js";

export interface AuditEntry {
  tokenId: number | null;
  tool: string;
  args: unknown;
  sql?: string | null;
  rowCount?: number | null;
  truncated?: boolean;
  error?: string | null;
  durationMs: number;
}

export type AuditWriter = (entry: AuditEntry) => Promise<void>;

/** Keys whose values never reach the audit log. */
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|cookie/i;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/gi;
const API_TOKEN = /\bflexi_[A-Za-z0-9_-]{20,}/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const BEARER = /\bBearer\s+\S+/gi;
const MAX_STRING = 500;

/**
 * Masks values in free text (audited SQL, error messages): e-mail addresses,
 * flexi API tokens, bearer values and long hex strings such as token hashes.
 */
export function redactText(value: string, maxLength = 10_000): string {
  const masked = value
    .replace(BEARER, "Bearer [redacted]")
    .replace(API_TOKEN, "[token]")
    .replace(LONG_HEX, "[hex]")
    .replace(EMAIL, "[email]");
  return masked.length > maxLength ? `${masked.slice(0, maxLength)}...[${masked.length - maxLength} more]` : masked;
}
const MAX_DEPTH = 6;

/**
 * Copy of tool arguments that is safe to store: sensitive keys (confirm tokens,
 * bearer values, passwords) become "[redacted]", e-mail addresses are masked,
 * long strings are cut. Never throws.
 */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[too deep]";
  if (typeof value === "string") {
    return redactText(value, MAX_STRING);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactArgs(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactArgs(v, depth + 1);
    }
    return out;
  }
  return value ?? null;
}

/**
 * Audit writer backed by `mcp_audit_log`. A failed insert never fails the tool
 * call, but it is logged (without SQL or arguments) so a silent gap is visible.
 */
export function createDbAuditWriter(db: Queryable, log: Logger): AuditWriter {
  return async (entry) => {
    try {
      await db.query(
        `insert into mcp_audit_log (token_id, tool, args_redacted, sql, row_count, truncated, error, duration_ms)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
        [
          entry.tokenId,
          entry.tool,
          JSON.stringify(redactArgs(entry.args ?? {})),
          entry.sql ? redactText(entry.sql) : null,
          entry.rowCount ?? null,
          entry.truncated ?? false,
          entry.error ? redactText(entry.error, 2000) : null,
          Math.max(0, Math.round(entry.durationMs)),
        ],
      );
    } catch (err) {
      log.error("mcp audit insert failed", {
        tool: entry.tool,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** Audit writer for live-only mode (no database): one redacted JSON line on stderr. */
export function createLogAuditWriter(log: Logger): AuditWriter {
  return async (entry) => {
    log.info("mcp tool call", {
      tool: entry.tool,
      tokenId: entry.tokenId,
      args: redactArgs(entry.args ?? {}),
      rowCount: entry.rowCount ?? null,
      truncated: entry.truncated ?? false,
      error: entry.error ? redactText(entry.error, 2000) : null,
      durationMs: Math.round(entry.durationMs),
    });
  };
}
