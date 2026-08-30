-- ROOK employer expansion — round 2 (cross-referenced against your
-- actual live employers table export, not just prior assumptions)
-- Run this in Supabase's SQL Editor.

-- STEP 1: Fix duplicate rows already in your table (same company,
-- same ats_identifier, different company_slug — these are scraping the
-- same employer twice on every ingest run). Keeping the more standard
-- slug in each pair, deleting the other.
delete from employers where company_slug = 'komodohealth' and ats_identifier = 'komodohealth';
delete from employers where company_slug = 'omadahealth' and ats_identifier = 'omadahealth';
delete from employers where company_slug = 'elanco-animal-health' and ats_identifier = 'elanco|wd5|External_Career';

-- STEP 2: Correct Danaher's existing row. It's currently set to the new,
-- untested Phenom adapter (jobs.danaher.com) — confirmed instead that
-- danaher.wd1.myworkdayjobs.com/DanaherJobs is a live, real Workday site
-- covering the same operating companies (Beckman Coulter, Cepheid, Leica
-- Biosystems, Leica Microsystems, SCIEX, Pall, Molecular Devices,
-- Radiometer, Cytiva), and Workday is the well-tested existing adapter.
-- workday.js now extracts the real per-job operating-company name from
-- each posting's own description text, so this still attributes jobs
-- correctly rather than labeling everything generically "Danaher."
update employers
set ats_type = 'workday', ats_identifier = 'danaher|wd1|DanaherJobs', updated_at = now()
where company_slug = 'danaher';

-- STEP 3: New employers. Cross-checked against your actual current
-- table export by both ats_identifier AND company_name (not just
-- assumed) — 37 companies from the source research were already
-- present under an identical identifier and are correctly excluded here.
-- A few employers below are shared Workday tenants covering several
-- real brands each — one row covers all of them:
--   Johnson & Johnson (jj|wd5|jj)      → covers DePuy Synthes, J&J Innovative
--                                          Medicine, J&J MedTech (workday.js
--                                          extracts the real brand per posting)
--   Envista (envista|wd1|envistacareers) → covers DEXIS, Kerr, Nobel Biocare, Ormco
--   Owens & Minor (owensminor|wd1|OMCareers) → covers Apria, Byram Healthcare
--   Stryker (stryker|wd1|strykercareers)     → covers Stryker Communications;
--                                                also now the correct home for
--                                                any Inari Medical roles (Inari
--                                                was acquired by Stryker)
--
-- Also checked and correctly NOT included as their own row:
--   Exact Sciences   — acquired by Abbott (already in your table)
--   Inari Medical    — acquired by Stryker (covered by the Stryker row above)
--   Shockwave Medical — acquired by Johnson & Johnson (covered by the J&J row above)
--   NuVasive          — now a Globus Medical subsidiary (Globus Medical already in your table)
--   MWI Animal Health, Cardinal Health at-Home — same tenant as employers
--                                                  already in your table
insert into employers (company_name, company_slug, ats_type, ats_identifier, industry, priority)
values
  ('Abridge', 'abridge', 'ashby', 'abridge', 'healthcare saas', 'normal'),
  ('Accuray', 'accuray', 'workday', 'accuray|wd5|External', 'other', 'normal'),
  ('Agiliti', 'agiliti', 'workday', 'agiliti|wd5|Sales', 'distribution', 'normal'),
  ('Akumin', 'akumin', 'workday', 'akumincorp|wd5|akumincareers', 'healthcare services', 'normal'),
  ('Alcon', 'alcon', 'workday', 'alcon|wd5|careers_alcon', 'medical device', 'normal'),
  ('Aledade', 'aledade', 'lever', 'aledade', 'healthcare services', 'normal'),
  ('Alnylam', 'alnylam', 'greenhouse', 'alnylampharmaceuticals', 'pharmaceutical', 'normal'),
  ('Alphatec Spine', 'alphatec-spine', 'workable', 'atec-spine', 'surgical/orthopedics', 'normal'),
  ('Ambience Healthcare', 'ambience-healthcare', 'ashby', 'ambiencehealthcare', 'healthcare saas', 'normal'),
  ('Amgen', 'amgen', 'workday', 'amgen|wd1|Careers', 'pharmaceutical', 'normal'),
  ('Antech', 'antech', 'workday', 'mvh|wd115|antechcareers', 'animal health', 'normal'),
  ('AstraZeneca', 'astrazeneca', 'workday', 'astrazeneca|wd3|Careers', 'pharmaceutical', 'normal'),
  ('Avantor', 'avantor', 'workday', 'vwr|wd1|avantorJobs', 'life science tools', 'normal'),
  ('Azenta Life Sciences', 'azenta-life-sciences', 'workday', 'azenta|wd1|AzentaJobs', 'life science tools', 'normal'),
  ('Bioventus', 'bioventus', 'workday', 'osv-bioventus|wd501|External', 'surgical/orthopedics', 'normal'),
  ('Brainlab', 'brainlab', 'smartrecruiters', 'Brainlab', 'other', 'normal'),
  ('Bristol Myers Squibb', 'bristol-myers-squibb', 'workday', 'bristolmyerssquibb|wd5|BMS', 'pharmaceutical', 'normal'),
  ('CSL Behring', 'csl-behring', 'workday', 'csl|wd1|CSL_External', 'pharmaceutical', 'normal'),
  ('Collegium Pharmaceutical', 'collegium-pharmaceutical', 'greenhouse', 'collegiumpharma', 'pharmaceutical', 'normal'),
  ('CooperCompanies', 'coopercompanies', 'oraclehcm', 'hcjy.fa.us2.oraclecloud.com|CX_1', 'medical device', 'normal'),
  ('Corcept Therapeutics', 'corcept-therapeutics', 'greenhouse', 'corcepttherapeutics', 'pharmaceutical', 'normal'),
  ('DaVita', 'davita', 'workday', 'davita|wd1|DKC_External', 'healthcare services', 'normal'),
  ('Dexcom', 'dexcom', 'workday', 'dexcom|wd1|Dexcom', 'medical device', 'normal'),
  ('Elekta', 'elekta', 'workday', 'elekta|wd3|Elekta_Careers', 'other', 'normal'),
  ('Eli Lilly', 'eli-lilly', 'workday', 'lilly|wd115|LLY', 'pharmaceutical', 'normal'),
  ('Enovis', 'enovis', 'workday', 'enovis|wd5|enovis', 'medical device', 'normal'),
  ('Envista', 'envista', 'workday', 'envista|wd1|envistacareers', 'dental', 'normal'),
  ('Eurofins', 'eurofins', 'smartrecruiters', 'Eurofins', 'diagnostics', 'normal'),
  ('Fresenius Kabi', 'fresenius-kabi', 'workday', 'freseniusglobal|wd3|FK_Careers', 'other', 'normal'),
  ('Fresenius Medical Care', 'fresenius-medical-care', 'workday', 'freseniusmedicalcare|wd3|fme', 'healthcare services', 'normal'),
  ('GSK', 'gsk', 'workday', 'gsk|wd5|GSKCareers', 'pharmaceutical', 'normal'),
  ('Gilead Sciences', 'gilead-sciences', 'workday', 'gilead|wd1|gileadcareers', 'pharmaceutical', 'normal'),
  ('Haemonetics', 'haemonetics', 'workday', 'haemonetics|wd5|HAE', 'medical device', 'normal'),
  ('Highridge Medical', 'highridge-medical', 'workday', 'highridgemedical|wd503|HRMCareers', 'surgical/orthopedics', 'normal'),
  ('ICU Medical', 'icu-medical', 'oraclehcm', 'eduu.fa.us2.oraclecloud.com|CX_1', 'medical device', 'normal'),
  ('IQVIA', 'iqvia', 'workday', 'iqvia|wd1|IQVIA', 'healthcare saas', 'normal'),
  ('Inogen', 'inogen', 'jobvite', 'inogen', 'medical device', 'normal'),
  ('Integra LifeSciences', 'integra-lifesciences', 'workday', 'integralife|wd1|Careers', 'medical device', 'normal'),
  ('Ironwood Pharmaceuticals', 'ironwood-pharmaceuticals', 'greenhouse', 'ironwoodpharmaceuticals', 'pharmaceutical', 'normal'),
  ('Jazz Pharmaceuticals', 'jazz-pharmaceuticals', 'workday', 'vhr-jazz|wd1|JazzPharmaceuticals', 'pharmaceutical', 'normal'),
  ('LivaNova', 'livanova', 'workday', 'livanova|wd5|Search', 'medical device', 'normal'),
  ('ModMed', 'modmed', 'workday', 'modmed|wd501|ModMed12', 'healthcare saas', 'normal'),
  ('Neurocrine Biosciences', 'neurocrine-biosciences', 'workday', 'neurocrine|wd5|Neurocrinecareers', 'pharmaceutical', 'normal'),
  ('New England Biolabs', 'new-england-biolabs', 'workday', 'neb|wd5|NEB_Careers', 'life science tools', 'normal'),
  ('Novartis', 'novartis', 'workday', 'novartis|wd3|Novartis_Careers', 'pharmaceutical', 'normal'),
  ('Oak Street Health', 'oak-street-health', 'workday', 'cvshealth|wd1|CVS_Health_Careers', 'healthcare services', 'normal'),
  ('Orthofix', 'orthofix', 'workday', 'orthofix|wd1|External_Careers', 'medical device', 'normal'),
  ('Otsuka', 'otsuka', 'workday', 'vhr-otsuka|wd1|External', 'pharmaceutical', 'normal'),
  ('Owens & Minor', 'owens-minor', 'workday', 'owensminor|wd1|OMCareers', 'distribution', 'normal'),
  ('Pfizer', 'pfizer', 'workday', 'pfizer|wd1|PfizerCareers', 'pharmaceutical', 'normal'),
  ('Philips', 'philips', 'workday', 'philips|wd3|jobs-and-careers', 'medical device', 'normal'),
  ('Privia Health', 'privia-health', 'smartrecruiters', 'PriviaHealth', 'healthcare services', 'normal'),
  ('QuidelOrtho', 'quidelortho', 'workday', 'orthoclinical|wd1|Search', 'diagnostics', 'normal'),
  ('R1 RCM', 'r1-rcm', 'workday', 'r1rcm|wd1|r1rcm', 'healthcare saas', 'normal'),
  ('Regeneron', 'regeneron', 'workday', 'regeneron|wd1|Careers', 'pharmaceutical', 'normal'),
  ('RxVantage', 'rxvantage', 'ashby', 'rxvantage', 'healthcare saas', 'normal'),
  ('SI-BONE', 'si-bone', 'greenhouse', 'siboneinc', 'surgical/orthopedics', 'normal'),
  ('Sanofi', 'sanofi', 'workday', 'sanofi|wd3|SanofiCareers', 'pharmaceutical', 'normal'),
  ('Sarepta Therapeutics', 'sarepta-therapeutics', 'workday', 'sarepta|wd5|sarepta_external', 'pharmaceutical', 'normal'),
  ('Septodont', 'septodont', 'workday', 'septodont|wd103|Septodont_Careers', 'dental', 'normal'),
  ('Shields Health Solutions', 'shields-health-solutions', 'greenhouse', 'shieldshealthsolutions', 'healthcare services', 'normal'),
  ('Smith+Nephew', 'smith-nephew', 'workday', 'smithnephew|wd5|External', 'medical device', 'normal'),
  ('Takeda', 'takeda', 'workday', 'takeda|wd3|External', 'pharmaceutical', 'normal'),
  ('Teladoc Health', 'teladoc-health', 'workday', 'teladoc|wd503|teladochealth_is_hiring', 'healthcare saas', 'normal'),
  ('Trupanion', 'trupanion', 'smartrecruiters', 'trupanion1', 'animal health', 'normal'),
  ('Ultradent', 'ultradent', 'workday', 'ultradent|wd1|careers', 'dental', 'normal'),
  ('Veradigm', 'veradigm', 'workday', 'veradigm|wd12|VR', 'healthcare saas', 'normal'),
  ('Vertex', 'vertex', 'workday', 'vrtx|wd501|Vertex_Careers', 'pharmaceutical', 'normal'),
  ('Vetsource', 'vetsource', 'workday', 'vetsource|wd504|vetsource_careers', 'animal health', 'normal'),
  ('Viatris', 'viatris', 'workday', 'viatris|wd5|External', 'pharmaceutical', 'normal'),
  ('Waystar', 'waystar', 'workday', 'waystar|wd1|Waystar', 'healthcare saas', 'normal'),
  ('WellSky', 'wellsky', 'workday', 'wellsky|wd1|WellSkyCareers', 'healthcare saas', 'normal'),
  ('Zoetis', 'zoetis', 'workday', 'zoetis|wd5|zoetis', 'animal health', 'normal'),
  ('Johnson & Johnson', 'johnson-johnson', 'workday', 'jj|wd5|jj', 'medical device', 'normal'),
  ('Stryker', 'stryker', 'workday', 'stryker|wd1|strykercareers', 'medical device', 'normal')
on conflict (company_slug) do update set
  ats_type = excluded.ats_type,
  ats_identifier = excluded.ats_identifier,
  industry = excluded.industry,
  updated_at = now();

-- Note: Zoetis was confirmed successfully running in tonight's actual
-- ingest log, but does not appear anywhere in your exported employers
-- table — worth a quick check after running this that it wasn't
-- accidentally duplicated under a different identifier elsewhere.
