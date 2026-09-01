-- ROOK — allow 'paylocity' as a valid ats_type
-- Run this BEFORE employer_expansion_paylocity.sql (or before any other
-- batch that includes a Paylocity-hosted employer) - the check
-- constraint on employers.ats_type doesn't know about this new adapter
-- yet, which is exactly the error just hit.

alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in ('greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite','applicantpro','icims','drupalcareers','teamtailor','pinpoint','eightfold','paylocity','custom','manual'));
