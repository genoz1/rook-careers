-- ROOK employer expansion — Paylocity batch (AdaptHealth, Nutramax)
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('AdaptHealth', 'adapthealth', 'paylocity', '4bcae427-e9e7-4d6d-9772-73ef70c3a278', 'home health', 'normal'),
  ('Nutramax Laboratories Veterinary Sciences', 'nutramax-laboratories', 'paylocity', '5f185140-2e78-4f28-bff0-a8c471a87c11', 'animal health', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
