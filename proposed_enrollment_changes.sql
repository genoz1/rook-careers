-- ROOK Careers — Source Adapter Validation, Sept 18 2026
-- PREPARED BUT NOT EXECUTED. Nothing in this file has been run against the
-- database. Only the one change below is backed by a confirmed diagnosis;
-- everything else in the accompanying report requires a live ingestion
-- run before it can be enrolled, per "do not activate unvalidated sources."

-- ============================================================
-- CONFIRMED FIX — safe to run once you're ready
-- ============================================================
-- Merit Medical Systems: stored Workday tenant number is wrong.
-- WebFetch of merit.com/careers confirmed the live tenant is wd503, not
-- wd1 (site slug "Merit" unchanged). This is a one-field correction to
-- an already-correctly-shaped identifier, not a new integration.
UPDATE employers
SET ats_identifier = 'merit|wd503|Merit',
    sync_status = 'pending'
WHERE id = '7e3289d4-afdb-4902-8a1b-97c6345d1c34'
  AND ats_type = 'workday';

-- ============================================================
-- EVERYTHING BELOW NEEDS A LIVE INGESTION RUN FIRST
-- (host/identifier confirmation only possible from a network that can
-- actually reach these external hosts — this sandbox cannot). Included
-- here as prepared drafts so the next session doesn't have to rediscover
-- the target ats_type, not as ready-to-run statements.
-- ============================================================

-- --- SuccessFactors (new adapter, tested on representative synthetic
-- fixtures, NOT yet run against live tenant HTML) ---
-- UPDATE employers SET sync_status='pending' WHERE id='a6938cd7-59e6-4b83-bd7a-631caf4fc630'; -- Astellas Pharma (ats_identifier already correct: careers.astellas.com)
-- UPDATE employers SET sync_status='pending' WHERE id='a25f7f4d-0483-4b99-a62a-02ce2fef1157'; -- Boehringer Ingelheim (ats_identifier already correct: jobs.boehringer-ingelheim.com)
-- INSERT new employer: Boston Scientific, ats_type='successfactors', ats_identifier='jobs.bostonscientific.com', careers_url='https://jobs.bostonscientific.com/'
-- INSERT new employer: Olympus, ats_type='successfactors', ats_identifier='careers.olympusamerica.com', careers_url='https://careers.olympusamerica.com/'
-- INSERT new employer: Teleflex, ats_type='successfactors', ats_identifier='careers.teleflex.com', careers_url='https://careers.teleflex.com/'
-- INSERT new employer: Getinge, ats_type='successfactors', ats_identifier='careers.getinge.com', careers_url='https://careers.getinge.com/'
-- INSERT new employer: Terumo, ats_type='successfactors', ats_identifier='careers.terumoamericas.com', careers_url='https://careers.terumoamericas.com/'
-- INSERT new employer: DiaSorin, ats_type='successfactors', ats_identifier='jobs.diasorin.com', careers_url='https://jobs.diasorin.com/'
-- INSERT new employer: Dentsply Sirona, ats_type='successfactors', ats_identifier='careers.dentsplysirona.com', careers_url='https://careers.dentsplysirona.com/'
-- INSERT new employer: KARL STORZ, ats_type='successfactors', ats_identifier='career.karlstorz.com', careers_url='https://career.karlstorz.com/'
-- Kedrion Biopharma, Ambu: NEEDS_ADAPTER — no job content returned, cause undetermined. Do not add yet.
-- Daiichi Sankyo (e8d541fc-d599-41f3-9228-4c25cf71be60): NEEDS_ADAPTER — same, no visible content.
-- Novo Nordisk (ce0a5057-e9e3-4b73-ae85-d5116285d844): UNSUPPORTED by this adapter — stored host is wrong;
--   real site is "classic" SuccessFactors (performancemanager.successfactors.eu), a different platform.

-- --- custom_html: TG Therapeutics — the one candidate validated through
-- the real extraction path this session ---
-- INSERT new employer: TG Therapeutics, ats_type='custom_html',
--   careers_url='https://www.tgtherapeutics.com/about-us/join-us/',
--   company_website='https://www.tgtherapeutics.com', industry='Pharmaceutical'

-- --- custom_html: everything else in the 27-candidate set redirects to
-- an existing adapter (config only) or is a new platform (NEEDS_ADAPTER)
-- or inconclusive — see the report table. None are enrollment-ready.

-- --- Workable: Ascendis Pharma (ADD, not an existing employer) ---
-- INSERT new employer: Ascendis Pharma, ats_type='workable', ats_identifier='ascendis-pharma',
--   careers_url='https://apply.workable.com/ascendis-pharma/'
-- Adapter fix already made (see backend/adapters/workable.js) and unit-tested;
-- still needs one live ingestion run to confirm the account slug is correct
-- and the fixed multi-location logic behaves against real API output.

-- --- Non-SuccessFactors UPDATE family ---
-- IDEXX Laboratories (3043b184-854d-4ab2-85ba-546a6cf08075): RESOLVED Round 2.
--   Confirmed live on Phenom People (careers.idexx.com, CDN path shows company
--   code IDEXUS). phenom.js keys off the hostname itself, not the company code.
-- UPDATE employers SET ats_type='phenom', ats_identifier='careers.idexx.com', sync_status='pending'
--   WHERE id='3043b184-854d-4ab2-85ba-546a6cf08075';
--
-- 10x Genomics (a6d523e2-7d47-452c-b941-da4f9e15a0d1): RESOLVED Round 2.
--   Real site redirects to careers.kula.ai/10xgenomics — confirmed real,
--   static, same-origin job board; validated through the actual
--   fetchCustomHtmlJobs/normalizeCustomHtmlJob path (3/3 tests pass). No
--   dedicated Kula adapter needed.
-- UPDATE employers SET ats_type='custom_html', ats_identifier=NULL,
--   careers_url='https://careers.kula.ai/10xgenomics', sync_status='pending'
--   WHERE id='a6d523e2-7d47-452c-b941-da4f9e15a0d1';
--
-- Castle Biosciences (efce93c7-4b16-4510-931d-6649ebf807d9): CORRECTED Round 2.
--   Round 1 flagged a URL-shape mismatch; that was mistaken — the
--   www.applicantpro.com/openings/castlebiosciences/jobs link is just a
--   redirect to castlebiosciences.applicantpro.com/jobs/, exactly what the
--   existing adapter already fetches. No adapter change, no config change.
--   Leave as-is; still needs a live run to confirm the unverified domain_id
--   regex and JSON field names (applicantpro.js's own stated caveat).
--
-- Takeda (317a6990-82e0-421e-9722-351791ff5287), Revvity (7ff33978-d02c-46f3-b8c7-9bb0301c34be):
--   still inconclusive (TalentBrew/Avature signals, neither confirms nor
--   rules out the stored Workday config). Not re-probed this round per the
--   "don't spend excessive credits repeatedly probing" instruction.

-- --- Priority 1 candidates resolved/attempted Round 2 (all ADD — none in baseline) ---
-- INSERT new employer: Bio-Rad Laboratories, ats_type='clinchtalent', ats_identifier='careers.bio-rad.com',
--   careers_url='https://careers.bio-rad.com/', industry='Life Sciences'
--   NOTE: clinchtalent.js cannot currently populate location_raw (known adapter gap, not fixed this round).
-- INSERT new employer: Align Technology, ats_type='pinpoint', ats_identifier='jobs.aligntech.com',
--   careers_url='https://jobs.aligntech.com/', industry='Medical Devices'
-- INSERT new employer: Kiniksa Pharmaceuticals, ats_type='greenhouse', ats_identifier='kiniksapharmaceuticals',
--   careers_url='https://boards.greenhouse.io/kiniksapharmaceuticals', industry='Pharmaceutical'
-- INSERT new employer: Midwest Veterinary Supply, ats_type='adp', ats_identifier='293ebbc2-72a4-4413-bd7b-e06ac6d58a7e',
--   careers_url='https://www.midwestvetsupply.com/our-company/careers/', industry='Veterinary Distribution'
-- INSERT new employer: Cytokinetics, ats_type='workday', ats_identifier='cytokinetics|wd1|Cytokinetics',
--   careers_url='https://cytokinetics.com/careers/', industry='Pharmaceutical'
-- INSERT new employer: Guerbet, ats_type='successfactors', ats_identifier='careers.guerbet.com',
--   careers_url='https://careers.guerbet.com/', industry='Medical Imaging'
-- MANUAL_REVIEW, not enrollment-ready: Apellis Pharmaceuticals (Workday site slug unconfirmed),
--   Bracco Diagnostics (Workday vs Dayforce unresolved), Amneal Pharmaceuticals (Oracle HCM siteNumber assumed)
-- NEEDS_ADAPTER, do not add: Supernus Pharmaceuticals — real platform is UKG Pro Recruit
--   (rec.pro.ukg.net), which the existing ukg.js adapter (built for UltiPro/ultipro.com) cannot reach.

-- --- Round 3 resolutions ---
-- INSERT new employer: Apellis Pharmaceuticals, ats_type='workday', ats_identifier='teamapellis|wd108|ApellisCareers',
--   careers_url='https://apellis.com/careers/open-positions/', industry='Pharmaceutical'
--   (site slug "ApellisCareers" confirmed directly off apellis.com's own Workday link)
-- INSERT new employer: Amneal Pharmaceuticals, ats_type='oraclehcm', ats_identifier='hcfa.fa.us2.oraclecloud.com|CX',
--   careers_url='https://amneal.com/careers/', industry='Pharmaceutical'
--   (siteNumber corrected to "CX" — Round 2's "CX_1" was an unconfirmed default, not what the real link shows)
-- INSERT new employer: Bracco Diagnostics, ats_type='workday', ats_identifier='bracco|wd103|BraccoCareers',
--   careers_url='https://www.bracco.com/careers', industry='Medical Imaging'
--   (Workday vs Dayforce resolved: Workday is the primary "Current job openings" link, Dayforce a secondary alternate)
-- Applied Medical, Incyte: still NEEDS_ADAPTER — Jibe investigated, no adapter built (no confirmed public
--   API, no reachable job data through this environment's access; see report for full reasoning). Do not add.
-- ZOLL Medical, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA, SOPHiA GENETICS:
--   re-investigated fresh, all still MANUAL_REVIEW — no job data reachable through this environment.
