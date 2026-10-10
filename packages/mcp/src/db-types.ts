/** The subset of pg used by this package, so tests can pass a fake. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface PoolClientLike {
  query(text: string | { text: string; values?: unknown[]; queryMode?: "extended" }, params?: unknown[]): Promise<{
    rows: any[];
    rowCount?: number | null;
  }>;
  release(): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}
