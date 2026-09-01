-- ROOK employer expansion — batch of 25, round 5
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Sartorius', 'sartorius', 'workday', 'sartorius|wd3|sartoriuscareers', 'life science tools', 'normal'),
  ('Revvity', 'revvity', 'workday', 'revvity|wd1|External', 'life science tools', 'normal'),
  ('STEMCELL Technologies', 'stemcell-technologies', 'workday', 'stemcell|wd3|External_Careers', 'life science tools', 'normal'),
  ('Signify Health', 'signify-health', 'greenhouse', 'signifyhealth', 'healthcare services', 'normal'),
  ('Quipt Home Medical', 'quipt-home-medical', 'paylocity', 'c0c0d604-5c20-48c1-bc04-247678a49bfa', 'home health', 'normal'),
  ('Rotech Healthcare', 'rotech-healthcare', 'icims', 'careers.rotech.com', 'home health', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
