-- ROOK employer expansion — Tempus AI
-- Reported directly: a real Tempus job (Orlando, JR202600766) wasn't
-- showing in search because Tempus was never successfully added as an
-- employer this session (my earlier research flagged it inconclusive).
-- Confirmed via multiple real live postings sharing this exact tenant.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Tempus AI', 'tempus-ai', 'workday', 'tempus|wd5|Tempus_Careers', 'diagnostics', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
