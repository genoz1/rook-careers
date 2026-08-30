-- ROOK employer expansion — batch 4
-- All ats_types here (smartrecruiters, oraclehcm, workday, phenom) are
-- already allowed by the master migration — no new constraint changes
-- needed for this batch.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Straumann', 'straumann', 'smartrecruiters', 'StraumannGroup1', 'dental', 'normal'),
  ('Alkermes', 'alkermes', 'oraclehcm', 'hbap.fa.us1.oraclecloud.com|CX_1', 'pharmaceutical', 'normal'),
  ('Masimo', 'masimo', 'oraclehcm', 'egcu.fa.us6.oraclecloud.com|CX', 'medical device', 'normal'),
  ('iRhythm', 'irhythm', 'workday', 'irhythmtech|wd5|iRhythm', 'medical device', 'normal'),
  ('UCB', 'ucb', 'phenom', 'careers.ucb.com', 'pharmaceutical', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
