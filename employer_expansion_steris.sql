-- ROOK employer expansion — STERIS (Phenom)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('STERIS', 'steris', 'phenom', 'careers.steris.com', 'medical device', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
