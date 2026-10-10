-- MCP server tables: API tokens for the HTTP transport and the audit log.

create table if not exists flexi_api_tokens (
  id bigserial primary key,
  name text not null,
  -- sha256 hex of the token. The plain token is shown once and never stored.
  token_sha256 text not null unique,
  -- An empty array grants nothing.
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  -- Soft revoke: the row stays so audit entries can be traced to it.
  revoked_at timestamptz
);

create index if not exists flexi_api_tokens_active_idx
  on flexi_api_tokens (token_sha256) where revoked_at is null;

create table if not exists mcp_audit_log (
  id bigserial primary key,
  -- No foreign key on purpose: the audit trail must outlive any token row.
  token_id bigint,
  tool text not null,
  -- Tool arguments with secrets (confirm tokens etc.) and e-mail addresses masked.
  args_redacted jsonb not null default '{}'::jsonb,
  sql text,
  row_count integer,
  truncated boolean not null default false,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists mcp_audit_log_created_idx on mcp_audit_log (created_at desc);
create index if not exists mcp_audit_log_token_idx on mcp_audit_log (token_id, created_at desc);
