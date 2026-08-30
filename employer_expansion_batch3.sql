-- ROOK employer expansion — batch 3
-- Includes 2 companies on brand-new adapters built this batch: Teamtailor
-- (3Shape) and Pinpoint (Exactech) — Pinpoint is officially documented as
-- public by Pinpoint themselves, higher confidence than most other new
-- adapters this session.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('3Shape', '3shape', 'teamtailor', 'careers.3shape.com', 'dental', 'normal'),
  ('Formlabs Dental', 'formlabs-dental', 'greenhouse', 'formlabs', 'dental', 'normal'),
  ('Exactech', 'exactech', 'pinpoint', 'exactech', 'surgical/orthopedics', 'normal'),
  ('Insmed', 'insmed', 'icims', 'careers-insmed', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
