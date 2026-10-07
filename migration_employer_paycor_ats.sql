-- Allow the general source-discovery pipeline to enroll verified Paycor
-- Recruiting (formerly Newton) boards. Safe and idempotent; no employers are
-- enrolled by this migration.
alter table public.employers drop constraint if exists employers_ats_type_check;
alter table public.employers add constraint employers_ats_type_check
  check (ats_type in (
    'greenhouse', 'lever', 'ashby', 'workday', 'talentbrew', 'workable', 'smartrecruiters', 'clinchtalent', 'oraclehcm', 'phenom', 'jobvite', 'applicantpro', 'icims', 'drupalcareers', 'teamtailor', 'pinpoint', 'eightfold', 'paylocity', 'paycor', 'adp', 'ukg', 'jazzhr', 'aemcareers', 'kula', 'successfactors', 'custom_html', 'custom', 'manual'
  ));
