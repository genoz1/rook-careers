-- ============================================================
-- New employer batch — 20 companies
-- Run in Supabase SQL editor (Settings → SQL Editor).
-- The ats_type constraint was updated in schema.sql to include:
--   'adp', 'ukg', 'jazzhr'
-- Run the ALTER TABLE below first if the constraint hasn't been
-- applied yet to your production database.
-- ============================================================

-- Step 1: extend the ats_type constraint to include the three new values.
-- This is additive and backward-compatible.
ALTER TABLE employers
  DROP CONSTRAINT IF EXISTS employers_ats_type_check;

ALTER TABLE employers
  ADD CONSTRAINT employers_ats_type_check
  CHECK (ats_type IN (
    'greenhouse','lever','ashby','workday','talentbrew','workable',
    'smartrecruiters','clinchtalent','oraclehcm','phenom','jobvite',
    'applicantpro','icims','drupalcareers','teamtailor','pinpoint',
    'eightfold','paylocity',
    'adp','ukg','jazzhr',
    'custom','manual'
  ));

-- Step 2: insert the 20 new employers.
-- Existing employers are skipped (ON CONFLICT DO NOTHING on company_slug).

INSERT INTO employers (
  company_name, company_slug, company_website, careers_url,
  industry, subindustry, ats_type, ats_identifier, source_url, active, priority
) VALUES

-- ── ADP Workforce Now employers (3) ───────────────────────────────────────────
-- Adapter: backend/adapters/adp.js
-- ats_identifier = the CID from the careers URL

('Aegis Sciences',
 'aegis-sciences',
 'https://aegissciences.com',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=3b6256c1-2a46-4436-9cdb-bc5511fc6ab2&lang=en_US',
 'Diagnostics', 'Toxicology / Clinical Laboratory',
 'adp', '3b6256c1-2a46-4436-9cdb-bc5511fc6ab2',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=3b6256c1-2a46-4436-9cdb-bc5511fc6ab2&lang=en_US',
 true, 'normal'),

('HealthTrackRx',
 'healthtrackrx',
 'https://healthtrackrx.com',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=43292fce-0576-4765-b344-b25348d7b9f8&lang=en_US',
 'Diagnostics', 'Point-of-Care / Toxicology',
 'adp', '43292fce-0576-4765-b344-b25348d7b9f8',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=43292fce-0576-4765-b344-b25348d7b9f8&lang=en_US',
 true, 'normal'),

('NMS Labs',
 'nms-labs',
 'https://nmslabs.com',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=b1dfa774-67ac-4bd6-9761-0cba8e72ff53&lang=en_US',
 'Diagnostics', 'Forensic / Clinical Laboratory',
 'adp', 'b1dfa774-67ac-4bd6-9761-0cba8e72ff53',
 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=b1dfa774-67ac-4bd6-9761-0cba8e72ff53&lang=en_US',
 true, 'normal'),

-- ── ADP Recruiting (legacy) employer (1) ──────────────────────────────────────
-- Adapter: backend/adapters/adp.js
-- ats_identifier = "recruiting:{c_param}:{d_param}"

('PathGroup',
 'pathgroup',
 'https://pathgroup.com',
 'https://recruiting.adp.com/srccar/public/RTI.home?c=1167551&d=PathGroupCareerSite',
 'Diagnostics', 'Pathology / Anatomic',
 'adp', 'recruiting:1167551:PathGroupCareerSite',
 'https://recruiting.adp.com/srccar/public/RTI.home?c=1167551&d=PathGroupCareerSite',
 true, 'normal'),

-- ── UKG Pro (UltiPro) employers (2) ───────────────────────────────────────────
-- Adapter: backend/adapters/ukg.js
-- ats_identifier = "host|ORG_CODE|board_id"

('Genova Diagnostics',
 'genova-diagnostics',
 'https://gdx.net',
 'https://recruiting.ultipro.com/GEN1019/JobBoard/bb822312-e746-def8-5d38-36b1544138df',
 'Diagnostics', 'Specialty / Functional Medicine',
 'ukg', 'recruiting.ultipro.com|GEN1019|bb822312-e746-def8-5d38-36b1544138df',
 'https://recruiting.ultipro.com/GEN1019/JobBoard/bb822312-e746-def8-5d38-36b1544138df',
 true, 'normal'),

('ARUP Laboratories',
 'arup-laboratories',
 'https://aruplab.com',
 'https://recruiting2.ultipro.com/ARU1000ARUP/JobBoard/62cc791d-612e-42e6-909f-0de27efe2038',
 'Diagnostics', 'Clinical Laboratory',
 'ukg', 'recruiting2.ultipro.com|ARU1000ARUP|62cc791d-612e-42e6-909f-0de27efe2038',
 'https://recruiting2.ultipro.com/ARU1000ARUP/JobBoard/62cc791d-612e-42e6-909f-0de27efe2038',
 true, 'normal'),

-- ── Workable employer (1) ──────────────────────────────────────────────────────
-- Adapter: backend/adapters/workable.js (existing)
-- ats_identifier = board slug from apply.workable.com/{slug}/

('Millennium Health',
 'millennium-health',
 'https://millenniumhealth.com',
 'https://apply.workable.com/millennium-health/',
 'Diagnostics', 'Toxicology / Medication Monitoring',
 'workable', 'millennium-health',
 'https://apply.workable.com/millennium-health/',
 true, 'normal'),

-- ── Lever employer (1) ────────────────────────────────────────────────────────
-- Adapter: backend/adapters/lever.js (existing)

('PetDesk',
 'petdesk',
 'https://petdesk.com',
 'https://jobs.lever.co/petdesk',
 'Healthcare Technology', 'Veterinary Practice Software',
 'lever', 'petdesk',
 'https://jobs.lever.co/petdesk',
 true, 'normal'),

-- ── Ashby employer (1) ────────────────────────────────────────────────────────
-- Adapter: backend/adapters/ashby.js (existing)

('Weave',
 'weave',
 'https://getweave.com',
 'https://jobs.ashbyhq.com/weave',
 'Healthcare Technology', 'Patient Communication / Practice Software',
 'ashby', 'weave',
 'https://jobs.ashbyhq.com/weave',
 true, 'normal'),

-- ── Paylocity employer (1) ────────────────────────────────────────────────────
-- Adapter: backend/adapters/paylocity.js (existing)
-- ats_identifier = the GUID from the careers URL

('KVP International',
 'kvp-international',
 'https://kvpinternational.com',
 'https://recruiting.paylocity.com/recruiting/jobs/All/5185d630-7b08-4a17-b664-4c81d3030393/Current-Openings',
 'Animal Health', 'Veterinary Distribution / Compounding',
 'paylocity', '5185d630-7b08-4a17-b664-4c81d3030393',
 'https://recruiting.paylocity.com/recruiting/jobs/All/5185d630-7b08-4a17-b664-4c81d3030393/Current-Openings',
 true, 'normal'),

-- ── Oracle HCM Cloud employer (1) ─────────────────────────────────────────────
-- Adapter: backend/adapters/oraclehcm.js (existing)
-- ats_identifier = "domain|siteNumber"

('Midmark',
 'midmark',
 'https://midmark.com',
 'https://hcor.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs',
 'Medical Device', 'Clinical Environment / Exam Room Equipment',
 'oraclehcm', 'hcor.fa.us2.oraclecloud.com|CX_1',
 'https://hcor.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs',
 true, 'normal'),

-- ── JazzHR / ApplyToJob employers (2) ────────────────────────────────────────
-- Adapter: backend/adapters/jazzhr.js
-- ats_identifier = subdomain slug ({slug}.applytojob.com)

('Instinct Science',
 'instinct-science',
 'https://instinct.vet',
 'https://instinctscience.applytojob.com/',
 'Healthcare Technology', 'Veterinary Practice Software',
 'jazzhr', 'instinctscience',
 'https://instinctscience.applytojob.com/',
 true, 'normal'),

('Syncromune',
 'syncromune',
 'https://syncromune.com',
 'https://syncromune.applytojob.com/apply',
 'Animal Health', 'Veterinary Oncology / Immunotherapy',
 'jazzhr', 'syncromune',
 'https://syncromune.applytojob.com/apply',
 true, 'normal'),

-- ── Manual / custom employers (7) ────────────────────────────────────────────
-- These need custom crawlers or manual entry (see notes).
-- They are added as active=true so they appear in the employer count,
-- but ingest.js will skip them until an adapter is built or jobs are
-- added manually. Set active=false if you prefer to hide them until ready.

-- Clinical Reference Laboratory — Oracle Taleo (no adapter yet)
-- Crawl: https://phg.tbe.taleo.net/phg03/ats/careers/v2/jobSearch?org=CRLCORP
('Clinical Reference Laboratory',
 'clinical-reference-laboratory',
 'https://clr.com',
 'https://phg.tbe.taleo.net/phg03/ats/careers/v2/jobSearch?act=redirectCwsV2&cws=39&org=CRLCORP',
 'Diagnostics', 'Clinical Laboratory',
 'manual', 'taleo:CRLCORP:39',
 'https://phg.tbe.taleo.net/phg03/ats/careers/v2/jobSearch?act=redirectCwsV2&cws=39&org=CRLCORP',
 true, 'low'),

-- Ceva Animal Health — Cornerstone OnDemand (no adapter yet)
-- Crawl: https://ceva.csod.com/ux/ats/careersite/3/home?c=ceva
('Ceva Animal Health',
 'ceva-animal-health',
 'https://ceva.com',
 'https://ceva.csod.com/ux/ats/careersite/3/home?c=ceva',
 'Animal Health', 'Veterinary Pharmaceuticals',
 'manual', 'cornerstone:ceva:3',
 'https://ceva.csod.com/ux/ats/careersite/3/home?c=ceva',
 true, 'low'),

-- Dechra Pharmaceuticals — custom Dechra platform (crawl structured search results)
-- Crawl: https://careers.dechra.com/jobs/search?country_codes[]=US
('Dechra Pharmaceuticals',
 'dechra-pharmaceuticals',
 'https://dechra.com',
 'https://careers.dechra.com/jobs/search?country_codes%5B%5D=US&page=1&query=',
 'Animal Health', 'Veterinary / Companion Animal Pharmaceuticals',
 'custom', NULL,
 'https://careers.dechra.com/jobs/search?country_codes%5B%5D=US&page=1&query=',
 true, 'low'),

-- Vetoquinol — custom global platform (filter to US)
-- Crawl: https://careers.vetoquinol.com/en/our-job-offers
('Vetoquinol',
 'vetoquinol',
 'https://vetoquinol.com',
 'https://careers.vetoquinol.com/en/our-job-offers',
 'Animal Health', 'Veterinary Pharmaceuticals',
 'custom', NULL,
 'https://careers.vetoquinol.com/en/our-job-offers',
 true, 'low'),

-- Digitail — Factorial HR (no adapter yet)
-- Crawl: https://digitail.factorialhr.com/
('Digitail',
 'digitail',
 'https://digitail.io',
 'https://digitail.factorialhr.com/',
 'Healthcare Technology', 'Veterinary Practice Software',
 'manual', 'factorial:digitail',
 'https://digitail.factorialhr.com/',
 true, 'low'),

-- Van Beek Natural Science — HireClick (no adapter yet)
-- Crawl: https://vanbeeknaturalscience.hireclick.com/jb/index.html
('Van Beek Natural Science',
 'van-beek-natural-science',
 'https://vanbeeknatural.com',
 'https://vanbeeknaturalscience.hireclick.com/jb/index.html',
 'Animal Health', 'Veterinary Nutrition / Supplements',
 'manual', 'hireclick:vanbeeknaturalscience',
 'https://vanbeeknaturalscience.hireclick.com/jb/index.html',
 true, 'low'),

-- US BioTek Laboratories — company-hosted page (parse directly)
-- Crawl: https://www.usbiotek.com/careers
('US BioTek Laboratories',
 'us-biotek-laboratories',
 'https://usbiotek.com',
 'https://www.usbiotek.com/careers',
 'Diagnostics', 'Specialty / Functional Testing',
 'custom', NULL,
 'https://www.usbiotek.com/careers',
 true, 'low')

ON CONFLICT (company_slug) DO NOTHING;
