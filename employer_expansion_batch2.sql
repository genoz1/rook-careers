-- ROOK employer expansion — additional iCIMS-confirmed diagnostics companies
-- Run in Supabase's SQL Editor (icims ats_type already allowed if you've
-- run the earlier iCIMS batch file).

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Werfen', 'werfen', 'icims', 'careers-werfen', 'diagnostics', 'normal'),
  ('Sysmex America', 'sysmex-america', 'icims', 'careers-sysmex', 'diagnostics', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
