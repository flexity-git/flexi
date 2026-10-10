-- Core tables. flexi_migrations itself is created by the runner before any file
-- is applied (see src/migrations.ts), so it is not defined here.

create table if not exists flexi_task_runs (
  id bigserial primary key,
  module text not null,
  task text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  error text,
  summary jsonb
);

create index if not exists flexi_task_runs_module_task_started_idx
  on flexi_task_runs (module, task, started_at desc);
