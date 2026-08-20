-- ROOK Careers — Phase 1 database schema
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New Query)
-- after creating your project. Safe to run once; re-running will error
-- on "already exists" for tables you've already created.

create extension if not exists vector;

-- ============================================================
-- EMPLOYERS — the companies ROOK pulls jobs from
-- ============================================================
create table if not exists employers (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  company_slug text unique not null,
  company_website text,
  careers_url text,
  industry text,
  subindustry text,
  ats_type text not null check (ats_type in ('greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','custom','manual')),
  ats_identifier text,               -- greenhouse board token / lever site / ashby job board name
  source_url text,
  active boolean default true,
  priority text default 'normal' check (priority in ('high','normal','low')),
  last_checked_at timestamptz,
  last_successful_sync_at timestamptz,
  sync_status text default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- JOBS — canonical, normalized job postings
-- ============================================================
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  source_job_id text,
  employer_id uuid references employers(id) on delete cascade,
  source_type text not null,
  source_url text,
  application_url text,

  title_original text,
  title_normalized text,
  company_name text,

  description_html text,
  description_text text,
  ai_analysis jsonb,                 -- structured requirements from backend/ai/jobAnalysis.js
                                      -- (required/preferred industries, product categories,
                                      -- customer types, seniority, clinical requirements with
                                      -- strength classification). Populated once per job by
                                      -- ingest.js, not on every re-ingestion run.

  location_raw text,
  city text,
  state text,
  region text,
  territory text,
  remote_status text,                -- 'remote' | 'field' | 'hybrid' | 'onsite'
  employment_type text,

  category text,                     -- normalized role family, e.g. "Territory Sales"
  subcategory text,
  industry text,                     -- e.g. "Veterinary Diagnostics"
  product_type text,
  sales_type text,                   -- 'hunter' | 'account_management' | etc.

  experience_min_years int,
  experience_max_years int,

  salary_min numeric,
  salary_max numeric,
  compensation_text text,

  travel_percentage int,
  overnight_travel boolean,

  required_skills text[],
  preferred_skills text[],
  required_experience text,
  preferred_experience text,
  degree_required text,
  certifications text[],

  date_posted date,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  status text default 'active' check (status in ('active','closed')),
  source_verified boolean default true,

  job_embedding vector(1536),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_jobs_employer on jobs(employer_id);
create index if not exists idx_jobs_status on jobs(status);
create index if not exists idx_jobs_category on jobs(category);

-- Required for backend/ingest.js's upsert (ON CONFLICT employer_id, source_job_id)
-- to work — without this, every ingestion run fails with a Postgres error
-- ("no unique or exclusion constraint matching the ON CONFLICT specification").
alter table jobs add constraint jobs_employer_source_unique unique (employer_id, source_job_id);

-- ============================================================
-- JOB DUPLICATES
-- ============================================================
create table if not exists job_duplicates (
  id uuid primary key default gen_random_uuid(),
  primary_job_id uuid references jobs(id) on delete cascade,
  duplicate_job_id uuid references jobs(id) on delete cascade,
  confidence numeric,
  reason text,
  created_at timestamptz default now()
);

-- ============================================================
-- CANDIDATE PROFILES
-- ============================================================
create table if not exists candidate_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade unique,
  name text,
  email text,
  phone text,

  home_city text,
  digest_enabled boolean default true,   -- opt-out flag for the daily match
                                          -- email; no settings UI toggle for
                                          -- this yet, but the column exists
                                          -- so a future UI doesn't need a migration
  last_digest_sent_at timestamptz,       -- used to only email about jobs seen
                                          -- since the last successful send,
                                          -- so the same job doesn't get
                                          -- re-emailed every single day
  home_state text,
  preferred_states text[],               -- states this candidate wants to see
                                          -- jobs from — distinct from home_state
                                          -- (where they live) and willing_to_relocate
                                          -- (how far they'd physically move). Drives
                                          -- location scoring in backend/matching.js
                                          -- alongside home_state, not instead of it.
  willing_to_relocate boolean default false,
  relocation_locations text[],           -- unused leftover from the original schema
                                          -- draft — nothing reads or writes this column
  preferred_states text[],
  preferred_cities text[],
  preferred_regions text[],
  territory_size_preference text,
  overnight_travel_preference text,
  maximum_travel_percentage int,

  current_title text,
  previous_titles text[],
  total_sales_years numeric,
  healthcare_sales_years numeric,
  veterinary_sales_years numeric,
  management_experience boolean default false,

  industry_experience jsonb default '{}'::jsonb,   -- { "diagnostics": true, "veterinary": true, ... }
  sales_experience jsonb default '{}'::jsonb,       -- { "hunter": true, "capital_equipment": true, ... }

  minimum_base_salary numeric,
  target_base_salary numeric,
  minimum_ote numeric,
  target_ote numeric,

  work_style text,                    -- 'remote' | 'field' | 'hybrid' | 'onsite'

  desired_titles text[],
  desired_industries text[],
  industries_to_avoid text[],
  companies_to_avoid text[],
  roles_to_avoid text[],

  candidate_embedding vector(1536),

  resume_file_path text,              -- Supabase Storage path
  resume_text text,                   -- extracted raw text
  resume_structured jsonb,            -- parsed employers/titles/dates/skills, user-confirmed
  suggested_roles jsonb,              -- AI-suggested job titles, computed once at résumé
                                       -- upload time alongside resume_structured — see
                                       -- backend/ai/roleSuggestions.js and backend/routes/profile.js

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- CANDIDATE <-> JOB MATCHES
-- ============================================================
create table if not exists candidate_job_matches (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidate_profiles(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,

  overall_score numeric,
  candidate_fit numeric,              -- from backend/matching.js's current 3-score model —
  preference_fit numeric,             -- these + overall_score/recommendation/confidence/
  recommendation text,                -- hard_disqualifier are the real fields scoreJob()
  reasons jsonb,                      -- outputs today. The columns below (industry_score,
  concerns jsonb,                     -- experience_score, etc.) are leftover from the
  confidence text,                    -- original schema draft, predating the current
  hard_disqualifier boolean,          -- matching engine — left in place harmlessly rather
  scored_at timestamptz,              -- than dropped, but nothing writes to them anymore.
  industry_score numeric,
  experience_score numeric,
  territory_score numeric,
  skills_score numeric,
  compensation_score numeric,
  travel_score numeric,
  semantic_score numeric,

  hard_requirement_pass boolean default true,
  strong_match_reasons text[],
  gaps text[],
  match_explanation text,

  calculated_at timestamptz default now(),
  dismissed boolean default false,
  generated_package jsonb,           -- cached output of backend/ai/applicationPackage.js
                                      -- so it's a real AI call once per candidate+job, not
                                      -- once per page visit — see backend/routes/applicationPackage.js
  generated_package_at timestamptz,
  saved boolean default false,
  interested boolean default false,

  unique (candidate_id, job_id)
);

create index if not exists idx_matches_candidate on candidate_job_matches(candidate_id);
create index if not exists idx_matches_score on candidate_job_matches(overall_score desc);

-- ============================================================
-- APPLICATIONS
-- ============================================================
create table if not exists applications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid references candidate_profiles(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  status text default 'interested' check (status in
    ('interested','saved','applied','recruiter_contact','phone_screen',
     'interview','final_interview','offer','rejected','withdrawn')),
  applied_at timestamptz,
  resume_version text,               -- Supabase Storage path to the tailored resume used
  notes text,
  follow_up_date date,
  contact_name text,
  contact_email text,
  interview_date timestamptz,
  offer_amount numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_applications_candidate on applications(candidate_id);

-- ============================================================
-- ROW LEVEL SECURITY — candidates only see their own data
-- ============================================================
alter table candidate_profiles enable row level security;
alter table candidate_job_matches enable row level security;
alter table applications enable row level security;

create policy "candidates read own profile" on candidate_profiles
  for select using (auth.uid() = user_id);
create policy "candidates update own profile" on candidate_profiles
  for update using (auth.uid() = user_id);
create policy "candidates insert own profile" on candidate_profiles
  for insert with check (auth.uid() = user_id);

create policy "candidates read own matches" on candidate_job_matches
  for select using (
    candidate_id in (select id from candidate_profiles where user_id = auth.uid())
  );

create policy "candidates read own applications" on applications
  for select using (
    candidate_id in (select id from candidate_profiles where user_id = auth.uid())
  );
create policy "candidates write own applications" on applications
  for all using (
    candidate_id in (select id from candidate_profiles where user_id = auth.uid())
  );

-- jobs and employers are meant to be publicly browsable data — but Supabase
-- now enables Row Level Security by default on every new table, which
-- silently returns zero rows to any query until a policy explicitly allows
-- it. This policy makes active jobs readable by anyone (candidates browsing
-- without an account, and the anon-key-based /api/jobs route). Writes are
-- unaffected — ingestion uses the service_role key, which bypasses RLS.
alter table jobs enable row level security;
create policy "public can read active jobs" on jobs
  for select using (status = 'active');
