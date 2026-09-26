-- Minimal, service-role-only audit trail for jobs rejected by the shared
-- title relevance predicate. Rows are pruned to a rolling 30-day window.
create table if not exists public.ingestion_title_filter_rejections (
  id bigint generated always as identity primary key,
  diagnostic_key text not null unique,
  rejected_at timestamptz not null,
  employer_id uuid references public.employers(id) on delete set null,
  company_name text,
  source_adapter text,
  source_job_id text,
  title text not null,
  location text,
  rejection_reason text not null
);

create index if not exists ingestion_title_filter_rejections_rejected_at_idx
  on public.ingestion_title_filter_rejections (rejected_at desc);
create index if not exists ingestion_title_filter_rejections_employer_time_idx
  on public.ingestion_title_filter_rejections (employer_id, rejected_at desc);

alter table public.ingestion_title_filter_rejections enable row level security;
revoke all on public.ingestion_title_filter_rejections from anon, authenticated;
grant select, insert, update, delete on public.ingestion_title_filter_rejections to service_role;
grant usage, select on sequence public.ingestion_title_filter_rejections_id_seq to service_role;
