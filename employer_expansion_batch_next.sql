-- ROOK employer expansion — batch (10x Genomics, BioMarin)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('10x Genomics', '10x-genomics', 'greenhouse', '10xgenomics', 'life science tools', 'normal'),
  ('BioMarin', 'biomarin', 'jobvite', 'biomarin', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
