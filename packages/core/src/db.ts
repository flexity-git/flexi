import pg from "pg";

const pools = new Map<string, pg.Pool>();

/**
 * Returns a shared pg Pool for the configured FLEXI_DATABASE_URL.
 * Pools are created lazily, one per connection string.
 */
export function getPool(config: { databaseUrl?: string | undefined }): pg.Pool {
  const url = config.databaseUrl;
  if (!url) throw new Error("FLEXI_DATABASE_URL is not configured. Set it to a Postgres connection string.");
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 5 });
    // An idle client error must not crash the process; the next query will fail visibly.
    pool.on("error", () => {});
    pools.set(url, pool);
  }
  return pool;
}

/** Ends every pool created by getPool. Safe to call more than once. */
export async function closePool(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((pool) => pool.end()));
}
