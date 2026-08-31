-- ROOK employer expansion — batch of 25, part 2
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Carestream Dental', 'carestream-dental', 'talentbrew', 'careers.carestream.com', 'dental', 'normal'),
  ('ATI Physical Therapy', 'ati-physical-therapy', 'icims', 'careers-atipt', 'healthcare services', 'normal'),
  ('Agfa HealthCare', 'agfa-healthcare', 'talentbrew', 'careers.agfa.com/HealthCare', 'capital equipment', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
