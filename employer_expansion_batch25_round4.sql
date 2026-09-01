-- ROOK employer expansion — batch of 25, round 4
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Netsmart', 'netsmart', 'workday', 'ntst|wd1|Careers', 'healthcare saas', 'normal'),
  ('NextGen Healthcare', 'nextgen-healthcare', 'workday', 'nextgen|wd5|NextGen_Careers', 'healthcare saas', 'normal'),
  ('Option Care Health', 'option-care-health', 'workday', 'optioncare|wd1|OptionCare', 'healthcare services', 'normal'),
  ('Organon', 'organon', 'workday', 'organon|wd5|SearchJobs', 'pharmaceutical', 'normal'),
  ('PacBio', 'pacbio', 'workday', 'pacbio|wd1|PacBio-', 'life science tools', 'normal'),
  ('Pacira BioSciences', 'pacira-biosciences', 'icims', 'careers.pacira.com', 'surgical/orthopedics', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();
