-- Durable operational summaries; no job or employer content is removed.
create table if not exists public.ingestion_runs (
  id uuid primary key,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null,
  summary jsonb not null default '{}'::jsonb
);
alter table public.ingestion_runs enable row level security;
-- Service-role only. No anonymous or authenticated client policies.
revoke all on public.ingestion_runs from anon, authenticated;
grant select, insert, update on public.ingestion_runs to service_role;
create index if not exists ingestion_runs_started_at_idx on public.ingestion_runs (started_at desc);

create table if not exists public.ingestion_incidents (
  employer_id uuid primary key references public.employers(id),
  incident_id uuid not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_run_id uuid not null,
  last_run_at timestamptz,
  consecutive_failures integer not null default 0,
  resolved_at timestamptz,
  emailed_at timestamptz,
  ai_attempted_at timestamptz,
  ai_diagnosis jsonb,
  ai_result jsonb,
  details jsonb not null default '{}'::jsonb
);
alter table public.ingestion_incidents enable row level security;
revoke all on public.ingestion_incidents from anon, authenticated;
grant select, insert, update on public.ingestion_incidents to service_role;

create table if not exists public.ingestion_watchdog_state (
  id integer primary key check (id = 1),
  last_checked_at timestamptz not null,
  problem text,
  incident_id uuid,
  failure_count integer not null default 0,
  ai_diagnosis jsonb,
  emailed_at timestamptz
);
alter table public.ingestion_watchdog_state enable row level security;
revoke all on public.ingestion_watchdog_state from anon, authenticated;
grant select, insert, update on public.ingestion_watchdog_state to service_role;

-- A verified identity/access exception can stop one source without closing jobs.
alter table public.employers add column if not exists ingestion_hold_reason text;
-- Preserve existing types while enabling the two verified public source contracts.
alter table public.employers drop constraint employers_ats_type_check;
alter table public.employers add constraint employers_ats_type_check check (ats_type in (
'greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite','applicantpro','icims','drupalcareers','teamtailor','pinpoint','eightfold','paylocity','adp','ukg','jazzhr','custom','manual','successfactors','custom_html','kula','aemcareers'));
create table if not exists public.ingestion_repair_backups (
 repair_id text not null, table_name text not null, row_id uuid not null, before_row jsonb not null,
 saved_at timestamptz not null default now(), primary key(repair_id,table_name,row_id)
);
alter table public.ingestion_repair_backups enable row level security;
revoke all on public.ingestion_repair_backups from anon, authenticated;
grant select,insert on public.ingestion_repair_backups to service_role;
