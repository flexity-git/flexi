export interface RetryOptions {
  /** Total attempts including the first one. Default 4. */
  maxAttempts?: number;
  /** Base delay for exponential backoff. Default 500 ms. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay. Default 30 000 ms. */
  maxDelayMs?: number;
  /** Upper bound applied to a server-provided `Retry-After`. Default 60 000 ms. */
  maxRetryAfterMs?: number;
}

export type ResolvedRetryOptions = Required<RetryOptions>;

export function resolveRetryOptions(opts: RetryOptions = {}): ResolvedRetryOptions {
  const resolved = {
    maxAttempts: opts.maxAttempts ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 30_000,
    maxRetryAfterMs: opts.maxRetryAfterMs ?? 60_000,
  };
  if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts must be a positive integer, got ${resolved.maxAttempts}`);
  }
  return resolved;
}

/**
 * Parse a `Retry-After` header given in seconds or as an HTTP date.
 * Returns null when the header is missing or unparseable.
 */
export function parseRetryAfterMs(header: string | null, capMs: number, now = Date.now()): number | null {
  if (header == null || header.trim() === "") return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, capMs);
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) {
    return Math.min(Math.max(at - now, 0), capMs);
  }
  return null;
}

/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped, then scaled
 * by a random factor in [0.5, 1) so parallel clients do not retry in lockstep.
 */
export function backoffDelayMs(attempt: number, opts: ResolvedRetryOptions, random = Math.random): number {
  const exp = Math.min(opts.baseDelayMs * 2 ** Math.max(attempt - 1, 0), opts.maxDelayMs);
  return Math.round(exp * (0.5 + random() * 0.5));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
