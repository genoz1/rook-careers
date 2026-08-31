-- ROOK employer expansion — Merck (shared tenant, extracts Merck Animal Health)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Merck', 'merck', 'workday', 'msd|wd5|SearchJobs', 'animal health', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
