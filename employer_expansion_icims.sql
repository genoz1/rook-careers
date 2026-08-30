-- ROOK employer expansion — iCIMS batch
-- New adapter (see backend/adapters/icims.js) — untested against a real
-- live response, treat these employers' first ingest run as the actual
-- test of the adapter itself. Run in Supabase's SQL Editor after
-- confirming icims is in your ats_type check constraint (it will be,
-- once this session's code changes are deployed).

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Bruker', 'bruker', 'icims', 'worldwidecareers-bruker', 'life science tools', 'normal'),
  ('DrFirst', 'drfirst', 'icims', 'careers-drfirst', 'healthcare saas', 'normal'),
  ('Fujifilm Healthcare', 'fujifilm-healthcare', 'icims', 'uscareers-fujifilm', 'capital equipment', 'normal'),
  ('Hamilton', 'hamilton', 'icims', 'careers-hamiltoncompany', 'life science tools', 'normal'),
  ('Select Medical', 'select-medical', 'icims', 'jobs-selectmedicalcorp', 'healthcare services', 'normal'),
  ('Waters Corporation', 'waters-corporation', 'icims', 'uscareers-waters', 'life science tools', 'normal'),
  ('symplr', 'symplr', 'icims', 'careers-symplr', 'healthcare saas', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- NOT included: RadNet — its careers URL (careers.radnet.com/erad/jobs/categories)
-- doesn't match the standard {subdomain}.icims.com pattern the adapter expects,
-- so its actual platform needs individual verification before adding.
