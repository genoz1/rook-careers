-- ROOK employer expansion — batch of 25, round 3
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Corin', 'corin', 'workable', 'corincareers', 'surgical/orthopedics', 'normal'),
  ('Eppendorf', 'eppendorf', 'workday', 'eppendorf|wd502|Eppendorf', 'life science tools', 'normal'),
  ('Hamilton Medical', 'hamilton-medical', 'icims', 'careers-hamiltonmedical', 'capital equipment', 'normal'),
  ('Medline', 'medline', 'workday', 'medline|wd5|Medline', 'healthcare distribution', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
