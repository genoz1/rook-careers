-- ROOK employer expansion — batch 5
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('AbbVie', 'abbvie', 'smartrecruiters', 'abbvie', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
