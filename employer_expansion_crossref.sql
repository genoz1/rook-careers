-- ROOK employer expansion — final cross-referenced batch
-- All ats_types here already allowed by the master migration.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('IDEXX', 'idexx', 'workday', 'idexx|wd1|IDEXX', 'animal health', 'normal'),
  ('Roche', 'roche', 'workday', 'roche|wd3|roche-ext', 'diagnostics', 'normal'),
  ('Virbac', 'virbac', 'workday', 'virbac|wd103|career', 'animal health', 'normal'),
  ('Teva', 'teva', 'eightfold', 'www.careers.teva|tevapharm.com', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- Note: Roche was found earlier in the session and marked "custom, no
-- ATS found" - that was wrong; corrected here with a real confirmed
-- Workday tenant. Roche Diagnostics specifically will show up under
-- this same "Roche" entry once ingested.
