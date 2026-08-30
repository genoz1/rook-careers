-- ROOK employer expansion — final batch of directly-verifiable additions
-- Run in Supabase's SQL Editor.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('ResMed', 'resmed', 'workday', 'resmed|wd3|ResMed_External_Careers', 'medical device', 'normal'),
  ('A-dec', 'a-dec', 'workday', 'adec|wd5|A-dec', 'dental', 'normal'),
  ('Intuitive Surgical', 'intuitive-surgical', 'smartrecruiters', 'Intuitive', 'medical device', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- Caris Life Sciences checked separately — already present in your table
-- with this exact identifier, no change needed.
