-- ROOK employer expansion — Drupal-careers batch
-- New adapter (see backend/adapters/drupalcareers.js) — this one WAS
-- confirmed via direct fetch against a real live response, meaningfully
-- more reliable than the other new adapters built tonight.

-- MUST run first: allows the new 'drupalcareers' ats_type.
alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in ('greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite','applicantpro','icims','drupalcareers','custom','manual'));

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Hologic', 'hologic', 'drupalcareers', 'careers.hologic.com', 'medical device', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
