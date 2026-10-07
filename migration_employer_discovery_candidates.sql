-- Durable, retryable state for automatic employer discovery. This migration is
-- additive; it does not activate, deactivate, or modify any existing employer.
create table if not exists employer_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  identity_key text unique not null,
  company_name text not null,
  normalized_company_name text not null,
  company_domain text,
  company_website text,
  careers_url text,
  job_url text,
  industry text,
  signal_source text not null,
  signal_payload jsonb not null default '{}'::jsonb,
  status text not null default 'received' check (status in (
    'received','resolving','validating','existing','enrolled','retryable','unresolved'
  )),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_signal_at timestamptz not null default now(),
  last_error text,
  evidence jsonb not null default '{}'::jsonb,
  detected_ats_type text,
  detected_ats_identifier text,
  validation_status text,
  validation_result jsonb,
  employer_id uuid references employers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employer_discovery_candidates_retry_idx
  on employer_discovery_candidates (status, next_attempt_at);
create index if not exists employer_discovery_candidates_domain_idx
  on employer_discovery_candidates (company_domain);
create index if not exists employer_discovery_candidates_source_idx
  on employer_discovery_candidates (detected_ats_type, detected_ats_identifier);

-- Discovery evidence may contain provider payloads and internal failure details.
-- The service-role worker can access it; public/anon clients cannot.
alter table employer_discovery_candidates enable row level security;

alter table employers add column if not exists discovery_candidate_id uuid
  references employer_discovery_candidates(id) on delete set null;
create index if not exists employers_discovery_candidate_idx on employers(discovery_candidate_id);
