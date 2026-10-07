-- ROOK — canonical ats_type constraint migration
-- Safe and idempotent. Keep this list aligned with backend/ingest.js.
-- Discovery may validate only a subset; it must never enroll an ATS without
-- a machine validator, but the database must accept every supported ingestion adapter.

alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in (
    'greenhouse', 'lever', 'ashby', 'workday', 'talentbrew', 'workable', 'smartrecruiters', 'clinchtalent', 'oraclehcm', 'phenom', 'jobvite', 'applicantpro', 'icims', 'drupalcareers', 'teamtailor', 'pinpoint', 'eightfold', 'paylocity', 'adp', 'ukg', 'jazzhr', 'aemcareers', 'kula', 'successfactors', 'custom_html', 'custom', 'manual'
  ));
