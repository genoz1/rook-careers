-- ROOK employer expansion — verified additions
-- Each company's ATS and identifier confirmed via real search/fetch,
-- not guessed. Run this in Supabase's SQL Editor. Safe to re-run —
-- upserts on company_slug, won't create duplicates.
--
-- Companies checked but NOT included here, with reasons:
--   Exact Sciences  — acquired by Abbott, jobs now post under Abbott (already in your list)
--   NeoGenomics     — uses Jobvite, not a currently supported ATS (needs new adapter)
--   Guardant Health — careers page renders jobs via JavaScript, could not confirm ATS without guessing
--   Beckman Coulter — Danaher-family company, runs on Phenom, not a currently supported ATS (needs new adapter)
--   Roche Diagnostics — custom career platform, no supported ATS found

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Natera', 'natera', 'greenhouse', 'natera', 'diagnostics', 'normal'),
  ('Myriad Genetics', 'myriad-genetics', 'oraclehcm', 'ekgn.fa.us6.oraclecloud.com|CX_2001', 'diagnostics', 'normal'),
  ('Adaptive Biotechnologies', 'adaptive-biotechnologies', 'greenhouse', 'adaptivebiotechnologies', 'diagnostics', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- Also checked, NOT included:
--   Castle Biosciences — uses ApplicantPro, not a currently supported ATS (needs new adapter)
--   Fulgent Genetics    — could not confirm ATS from available search results
