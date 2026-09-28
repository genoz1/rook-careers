-- ROOK Ad Manager portfolio preview setting. No ad writes are enabled by this migration.
create table if not exists ad_manager_portfolio_budget (
  id boolean primary key default true check (id = true),
  daily_budget_cents integer not null check (daily_budget_cents between 100 and 1000000),
  updated_at timestamptz not null default now()
);
alter table ad_manager_portfolio_budget enable row level security;
revoke all on ad_manager_portfolio_budget from anon, authenticated;
grant select, insert, update on ad_manager_portfolio_budget to service_role;
