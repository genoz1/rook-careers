-- ROOK employer expansion — Zimmer Biomet (Phenom)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Zimmer Biomet', 'zimmer-biomet', 'phenom', 'careers.zimmerbiomet.com', 'surgical/orthopedics', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
