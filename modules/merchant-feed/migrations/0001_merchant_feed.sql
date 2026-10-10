-- Merchant feed rules and run history. Product data is read from the mirror
-- tables owned by modules/mirror; this module never writes to them.

create table if not exists feed_rules (
  id bigserial primary key,
  -- 'google', 'heureka', 'zbozi' or '*' for every feed.
  feed text not null check (feed in ('google', 'heureka', 'zbozi', '*')),
  -- null applies the rule to every store.
  store_key text,
  "match" jsonb not null default '{}'::jsonb,
  action text not null check (action in ('exclude', 'set')),
  "set" jsonb,
  enabled boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  check (action <> 'set' or "set" is not null)
);

create index if not exists feed_rules_feed_store_idx on feed_rules (feed, store_key) where enabled;

create table if not exists feed_runs (
  id bigserial primary key,
  feed text not null,
  store_key text not null,
  item_count integer not null,
  error_count integer not null,
  -- false when the circuit breaker kept the previously published file.
  written boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists feed_runs_feed_store_created_idx on feed_runs (feed, store_key, created_at desc);
