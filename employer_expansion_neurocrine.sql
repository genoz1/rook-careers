-- ROOK employer expansion — Neurocrine Biosciences (Workday)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Neurocrine Biosciences', 'neurocrine-biosciences', 'workday', 'neurocrine|wd5|Neurocrinecareers', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
