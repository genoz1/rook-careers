-- ROOK — master ats_type constraint migration
-- Safe to run any time, any number of times, in any order relative to
-- the other employer_expansion*.sql files. Run this once now and you
-- won't hit "violates check constraint employers_ats_type_check" again
-- for any adapter built this session, regardless of which batch file
-- you run it before or after.

alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in (
    'greenhouse', 'lever', 'ashby', 'workday', 'talentbrew', 'workable',
    'smartrecruiters', 'clinchtalent', 'oraclehcm',
    'phenom', 'jobvite', 'applicantpro', 'icims', 'drupalcareers',
    'teamtailor', 'pinpoint',
    'custom', 'manual'
  ));
