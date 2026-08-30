-- ROOK employer expansion — iCIMS batch
-- New adapter (see backend/adapters/icims.js) — untested against a real
-- live response, treat these employers' first ingest run as the actual
-- test of the adapter itself. Run in Supabase's SQL Editor.

-- MUST run first: allows the new 'icims' ats_type on your live table.
-- (Postgres's default auto-generated name for this constraint is
-- employers_ats_type_check; if yours is named differently, Supabase's
-- error message will show the real name to substitute below.)
alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in ('greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite','applicantpro','icims','custom','manual'));

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Bruker', 'bruker', 'icims', 'worldwidecareers-bruker', 'life science tools', 'normal'),
  ('DrFirst', 'drfirst', 'icims', 'careers-drfirst', 'healthcare saas', 'normal'),
  ('Fujifilm Healthcare', 'fujifilm-healthcare', 'icims', 'uscareers-fujifilm', 'capital equipment', 'normal'),
  ('Hamilton', 'hamilton', 'icims', 'careers-hamiltoncompany', 'life science tools', 'normal'),
  ('Select Medical', 'select-medical', 'icims', 'jobs-selectmedicalcorp', 'healthcare services', 'normal'),
  ('Waters Corporation', 'waters-corporation', 'icims', 'uscareers-waters', 'life science tools', 'normal'),
  ('symplr', 'symplr', 'icims', 'careers-symplr', 'healthcare saas', 'normal'),
  ('agilon health', 'agilon-health', 'workday', 'agilonhealth|wd1|External', 'healthcare services', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- NOT included: RadNet — its careers URL (careers.radnet.com/erad/jobs/categories)
-- doesn't match the standard {subdomain}.icims.com pattern the adapter expects,
-- so its actual platform needs individual verification before adding.
