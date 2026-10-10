import type { Logger } from "@flexity/core";
import type { PoolClientLike, PoolLike } from "./db.js";

export interface RecordedQuery {
  text: string;
  params: unknown[];
}

/** In-memory stand-in for pg.Pool that records every statement. */
export function createFakePool(opts: { syncState?: Record<string, unknown> | null; failOn?: RegExp } = {}) {
  const queries: RecordedQuery[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (opts.failOn?.test(text)) throw new Error("simulated database failure");
    if (/from shoptet_sync_state/.test(text)) return { rows: opts.syncState ? [opts.syncState] : [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const client: PoolClientLike = { query, release: () => {} };
  const pool: PoolLike = { query, connect: async () => client };
  return { pool, queries };
}

/** The params of the last write to shoptet_sync_state, keyed by meaning. */
export function lastSyncStateWrite(queries: readonly RecordedQuery[]) {
  const q = [...queries].reverse().find((x) => /insert into shoptet_sync_state/.test(x.text));
  if (!q) return null;
  const [storeKey, resource, cursor, ok, , error, cursorProvided] = q.params;
  return { storeKey, resource, cursor, ok, error, cursorProvided };
}

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};
