-- ROOK employer expansion — Bayer (Eightfold)
-- New adapter, but confirmed against a real raw response for this exact
-- employer (see backend/adapters/eightfold.js). The "domain" half of
-- the identifier (bayer.com) is a reasonable guess following the
-- pattern seen elsewhere, not independently confirmed - if the first
-- real ingest run for Bayer comes back empty, that's the piece to
-- check first.

alter table employers drop constraint if exists employers_ats_type_check;
alter table employers add constraint employers_ats_type_check
  check (ats_type in ('greenhouse','lever','ashby','workday','talentbrew','workable','smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite','applicantpro','icims','drupalcareers','teamtailor','pinpoint','eightfold','custom','manual'));

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Bayer', 'bayer', 'eightfold', 'bayer|bayer.com', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
