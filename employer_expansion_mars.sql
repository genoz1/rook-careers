-- ROOK employer expansion — Mars (shared tenant, pet-care brand extraction)
-- Covers Royal Canin, Wisdom Panel, Mars Veterinary Health, Banfield,
-- BluePearl, AniCura, Linnaeus, and Antech via per-job brand extraction
-- (see backend/adapters/workday.js SHARED_TENANT_BRANDS.mars) -
-- combined with the existing title-relevance filter, which already
-- screens out the rest of Mars's non-petcare businesses.

insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Mars', 'mars', 'workday', 'mars|wd3|External', 'animal health', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
