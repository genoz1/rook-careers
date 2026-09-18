// Runnable script for autonomous employer discovery. Meant to run on a
// schedule via a DigitalOcean Scheduled Job (npm run discover-employers),
// same pattern as ingest.js, precomputeScores.js, and sendDigest.js.
//
// WHAT THIS DOES AND WHY IT EXISTS
// ---------------------------------
// Every ATS this app supports (Greenhouse, Lever, Ashby, SmartRecruiters,
// Workable, Workday) exposes a genuinely public, unauthenticated API for
// listing an employer's jobs — the same one their own careers page calls.
// The only unknown per employer is which platform they're on and what
// their exact "slug"/identifier is on it. This script closes that gap
// WITHOUT a human (or Claude) manually searching the web for each one:
// it takes a plain company name, generates a handful of plausible slug
// guesses from it, and tries each supported ATS's real API directly.
// A guess is only ever trusted if the platform's own API returns real,
// parseable job data for it — never a fuzzy/partial match.
//
// This deliberately trades recall for precision. A company that isn't
// found here isn't necessarily unreachable — it might be on a platform
// this app doesn't support yet (Phenom, Jobvite, ApplicantPro, iCIMS,
// SuccessFactors, or a fully custom site), or its actual slug might not
// match any of the guessed variants. Those get logged, not guessed at
// with a possibly-wrong identifier — a wrong identifier can silently
// return zero jobs forever, which is worse than not adding the employer
// at all. Companies logged as "not found" are exactly the ones that
// still need a real web search (by a human or by Claude) or a new
// adapter to be built, not a job for this script.
//
// One candidate employer's discovery failing doesn't stop the run for
// anyone else — same resilience pattern as every other scheduled
// script here.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { fetchGreenhouseJobs } = require("./adapters/greenhouse");
const { fetchLeverJobs } = require("./adapters/lever");
const { fetchAshbyJobs } = require("./adapters/ashby");
const { fetchSmartRecruitersJobs } = require("./adapters/smartrecruiters");
const { fetchWorkableJobs } = require("./adapters/workable");
const { fetchWorkdayJobs } = require("./adapters/workday");
// Added later than the original 6 above — these adapters were built
// afterward (to fix specific already-known employers) and never wired
// into discovery, even though each one only needs a single guessable
// slug/subdomain, exactly like Greenhouse/Lever/Ashby/etc. UKG,
// Eightfold, Phenom, Oracle HCM, ADP, JazzHR and Paylocity are
// deliberately left out here — each needs a real per-employer ID (an
// org code, a tenant number, a GUID) that can't be derived from the
// company name, so blind-guessing them would risk exactly the kind of
// wrong-but-plausible identifier this script is designed to avoid.
const { fetchIcimsJobs } = require("./adapters/icims");
const { fetchApplicantProJobs } = require("./adapters/applicantpro");
const { fetchJobviteJobs } = require("./adapters/jobvite");
const { fetchTeamtailorJobs } = require("./adapters/teamtailor");
const { fetchPinpointJobs } = require("./adapters/pinpoint");
const { fetchClinchTalentJobs } = require("./adapters/clinchtalent");
const { fetchDrupalCareersJobs } = require("./adapters/drupalcareers");
const { fetchTalentBrewJobs } = require("./adapters/talentbrew");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A small, polite pause between outbound requests — these are other
// companies' production APIs, not infrastructure built to be probed
// hundreds of times in a row.
const PAUSE_MS = 250;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Keeps each employer's discovery attempt bounded — some of these
// guesses (especially Workday's multiple tenant-number combinations)
// could otherwise hang on a slow/unresponsive host and stall the
// whole run.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("discovery attempt timed out")), ms)),
  ]);
}

// Turns a plain company name into the handful of slug conventions
// real companies actually use across these platforms — with vs.
// without hyphens, with vs. without spaces, common suffixes stripped.
function slugCandidates(name) {
  const base = name
    .replace(/[®™©]/g, "")
    .replace(/\([^)]*\)/g, "") // drop parenthetical alt-names, e.g. "BD (Becton, Dickinson and Company)"
    .replace(/[,.]/g, "")
    .trim();
  const stripped = base
    .replace(/\b(Inc|LLC|Corp|Corporation|Company|Co|Ltd|Group|Holdings|USA|US)\b\.?/gi, "")
    .trim();
  const variants = new Set();
  for (const v of [base, stripped]) {
    const lower = v.toLowerCase().trim();
    const noSpace = lower.replace(/[^a-z0-9]+/g, "");
    const hyphenated = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (noSpace) variants.add(noSpace);
    if (hyphenated) variants.add(hyphenated);
  }
  return Array.from(variants);
}

// Tries a fetch function against every slug candidate for one platform,
// returning the first one that comes back with real job data.
async function tryPlatform(fetchFn, candidates, minJobs = 1) {
  for (const slug of candidates) {
    try {
      const jobs = await withTimeout(fetchFn(slug), 12_000);
      if (Array.isArray(jobs) && jobs.length >= minJobs) {
        return { identifier: slug, jobCount: jobs.length };
      }
    } catch {
      // Wrong slug for this platform, or this employer isn't on it —
      // expected for the large majority of guesses. Just move on.
    }
    await sleep(PAUSE_MS);
  }
  return null;
}

// Workday needs three pieces (tenant|wdNumber|site), not just one slug,
// and the wdNumber genuinely can't be derived from the company name at
// all — it's assigned by Workday when the employer's tenant was set up.
// wd1, wd3, and wd5 cover a large share of real employers in practice,
// so this tries those specifically rather than an unbounded range.
async function tryWorkday(candidates) {
  const wdNumbers = ["wd1", "wd3", "wd5"];
  for (const tenant of candidates) {
    for (const wdNumber of wdNumbers) {
      for (const site of [tenant, `${tenant}careers`, "External"]) {
        const identifier = `${tenant}|${wdNumber}|${site}`;
        try {
          const jobs = await withTimeout(fetchWorkdayJobs(identifier), 12_000);
          if (Array.isArray(jobs) && jobs.length >= 1) {
            return { identifier, jobCount: jobs.length };
          }
        } catch {
          // Expected for almost every combination — only a handful of
          // tenant/wdNumber/site triples are ever real for a given company.
        }
        await sleep(PAUSE_MS);
      }
    }
  }
  return null;
}

// One entry per target employer: name plus the industry tag to store
// alongside it. This is the master target list — add more here over
// time; the script skips anything already in the employers table, so
// it's always safe to re-run against a longer list later.
const TARGET_EMPLOYERS = [
  // Medical device / MedTech
  ["Stryker", "medical device"], ["Zimmer Biomet", "medical device"], ["Smith+Nephew", "medical device"],
  ["Edwards Lifesciences", "medical device"], ["Intuitive Surgical", "medical device"], ["Hologic", "medical device"],
  ["Integra LifeSciences", "medical device"], ["Teleflex", "medical device"], ["Masimo", "medical device"],
  ["ZOLL Medical", "medical device"], ["ResMed", "medical device"], ["Dexcom", "medical device"],
  ["Insulet", "medical device"], ["Tandem Diabetes Care", "medical device"], ["Globus Medical", "medical device"],
  ["CooperCompanies", "medical device"], ["Haemonetics", "medical device"], ["Penumbra", "medical device"],
  ["Inari Medical", "medical device"], ["Shockwave Medical", "medical device"], ["Merit Medical", "medical device"],
  ["CONMED", "medical device"], ["Artivion", "medical device"], ["Enovis", "medical device"],
  ["Orthofix", "medical device"], ["NuVasive", "medical device"], ["Solventum", "medical device"],
  ["STERIS", "medical device"], ["Natus Medical", "medical device"], ["LivaNova", "medical device"],
  ["ICU Medical", "medical device"], ["Inogen", "medical device"], ["iRhythm", "medical device"],
  ["Axonics", "medical device"],
  // Medical device / MedTech — new additions, verified via real, current job
  // postings directly on Greenhouse/Lever/Ashby (not guessed slugs)
  ["Lexington Medical", "medical device"], ["Noctrix Health", "medical device"],
  ["Jupiter Endovascular", "medical device"], ["Noah Medical", "medical device"],
  ["Calyxo", "medical device"], ["CVRx", "medical device"],
  // Healthcare SaaS — new additions, verified
  ["AcuityMD", "healthcare saas"], ["SamaCare", "healthcare saas"],
  // Home health / DME — new addition, verified
  ["Dr. Comfort", "home health/dme"],
  // Specialty pharma — new category; verified via a real, current multi-city
  // Territory Manager hiring campaign on Greenhouse
  ["Mineralys Therapeutics", "pharma"],
  // Diagnostics / lab / precision medicine
  ["Cepheid", "diagnostics"], ["Sysmex America", "diagnostics"], ["bioMerieux", "diagnostics"],
  ["Werfen", "diagnostics"], ["QuidelOrtho", "diagnostics"], ["Illumina", "diagnostics"],
  ["QIAGEN", "diagnostics"], ["Bio-Rad", "diagnostics"], ["Tempus AI", "diagnostics"],
  ["Caris Life Sciences", "diagnostics"], ["Foundation Medicine", "diagnostics"], ["Sonic Healthcare USA", "diagnostics"],
  ["Eurofins", "diagnostics"], ["PathGroup", "diagnostics"], ["GeneDx", "diagnostics"],
  ["Biodesix", "diagnostics"],
  // Life-science / research equipment
  ["Cytiva", "life science tools"], ["Leica Microsystems", "life science tools"], ["Leica Biosystems", "life science tools"],
  ["Molecular Devices", "life science tools"], ["SCIEX", "life science tools"], ["Pall", "life science tools"],
  ["Sartorius", "life science tools"], ["Bruker", "life science tools"], ["Waters Corporation", "life science tools"],
  ["Revvity", "life science tools"], ["Bio-Techne", "life science tools"], ["10x Genomics", "life science tools"],
  ["PacBio", "life science tools"], ["Oxford Nanopore Technologies", "life science tools"], ["Standard BioTools", "life science tools"],
  ["Hamilton", "life science tools"], ["Eppendorf", "life science tools"], ["Tecan", "life science tools"],
  ["Miltenyi Biotec", "life science tools"], ["BioLegend", "life science tools"], ["Charles River Laboratories", "life science tools"],
  ["Azenta Life Sciences", "life science tools"], ["STEMCELL Technologies", "life science tools"], ["Takara Bio", "life science tools"],
  ["Promega", "life science tools"], ["New England Biolabs", "life science tools"],
  // Surgical / orthopedics / specialty device
  ["Arthrex", "surgical/orthopedics"], ["Paragon 28", "surgical/orthopedics"], ["Exactech", "surgical/orthopedics"],
  ["MicroPort Orthopedics", "surgical/orthopedics"], ["Treace Medical Concepts", "surgical/orthopedics"], ["OrthoPediatrics", "surgical/orthopedics"],
  ["SI-BONE", "surgical/orthopedics"], ["Alphatec Spine", "surgical/orthopedics"], ["SeaSpine", "surgical/orthopedics"],
  ["Centinel Spine", "surgical/orthopedics"], ["Spinal Elements", "surgical/orthopedics"], ["Bioventus", "surgical/orthopedics"],
  ["Pacira BioSciences", "surgical/orthopedics"], ["Organogenesis", "surgical/orthopedics"], ["MiMedx", "surgical/orthopedics"],
  ["Convatec", "surgical/orthopedics"], ["Tactile Medical", "surgical/orthopedics"], ["Avanos Medical", "surgical/orthopedics"],
  ["Ambu", "surgical/orthopedics"], ["Cook Medical", "surgical/orthopedics"],
  // Dental
  ["Dentsply Sirona", "dental"], ["Envista", "dental"], ["Ormco", "dental"],
  ["Align Technology", "dental"], ["BioHorizons", "dental"], ["ZimVie Dental", "dental"],
  ["DEXIS", "dental"], ["A-dec", "dental"], ["Ultradent", "dental"],
  ["Formlabs Dental", "dental"],
  // Healthcare distribution
  ["Medline", "distribution"], ["Owens & Minor", "distribution"], ["Concordance Healthcare Solutions", "distribution"],
  ["US Med-Equip", "distribution"], ["Agiliti", "distribution"], ["AdaptHealth", "distribution"],
  ["Lincare", "distribution"],
  // Healthcare SaaS / healthcare technology
  ["athenahealth", "healthcare saas"], ["eClinicalWorks", "healthcare saas"], ["NextGen Healthcare", "healthcare saas"],
  ["Veradigm", "healthcare saas"], ["Waystar", "healthcare saas"], ["R1 RCM", "healthcare saas"],
  ["Phreesia", "healthcare saas"], ["Doximity", "healthcare saas"], ["Definitive Healthcare", "healthcare saas"],
  ["Health Catalyst", "healthcare saas"], ["Innovaccer", "healthcare saas"], ["PointClickCare", "healthcare saas"],
  ["Netsmart", "healthcare saas"], ["symplr", "healthcare saas"], ["Relias", "healthcare saas"],
  ["ModMed", "healthcare saas"], ["Tebra", "healthcare saas"], ["Nextech", "healthcare saas"],
  ["WebPT", "healthcare saas"], ["Notable", "healthcare saas"], ["Cedar", "healthcare saas"],
  ["Included Health", "healthcare saas"], ["Omada Health", "healthcare saas"], ["Hinge Health", "healthcare saas"],
  ["Sword Health", "healthcare saas"], ["Amwell", "healthcare saas"], ["Zocdoc", "healthcare saas"],
  ["WellSky", "healthcare saas"], ["DrFirst", "healthcare saas"], ["Komodo Health", "healthcare saas"],
  ["Veeva Systems", "healthcare saas"], ["IQVIA", "healthcare saas"],
  // Animal health / veterinary
  ["Antech", "animal health"], ["Bimeda", "animal health"], ["Dechra", "animal health"],
  ["Ceva Animal Health", "animal health"], ["Virbac", "animal health"], ["Vetoquinol", "animal health"],
  ["Norbrook", "animal health"], ["Phibro Animal Health", "animal health"], ["Neogen", "animal health"],
  ["Covetrus", "animal health"], ["Patterson Veterinary", "animal health"], ["Vetcove", "animal health"],
  ["PetIQ", "animal health"], ["Trupanion", "animal health"], ["Nutramax Laboratories", "animal health"],
  ["Vetsource", "animal health"], ["ezyVet", "animal health"], ["Instinct Science", "animal health"],
  ["PetDx", "animal health"], ["Embark Veterinary", "animal health"],
  // Animal health / veterinary — new additions (manufacturers, diagnostics,
  // pharma, and distribution, matching the pattern above; deliberately
  // excludes hospital-operator groups like VCA and pet e-commerce/retail
  // like Chewy per direct instruction — those aren't the field-sales-rep
  // employer type this list targets)
  ["Hill's Pet Nutrition", "animal health"], ["Nestle Purina PetCare", "animal health"],
  ["Blue Buffalo", "animal health"], ["Henry Schein Animal Health", "animal health"],
  ["Merck Animal Health", "animal health"], ["Mars Petcare", "animal health"],
  ["Heska", "animal health"], ["Zomedica", "animal health"],
  ["Midmark", "animal health"], ["Putney", "animal health"], ["Assisi Animal Health", "animal health"],
  ["PetVivo Holdings", "animal health"], ["Piedmont Animal Health", "animal health"],
  ["Anivive Lifesciences", "animal health"],
  // Animal health — verified via real, current job postings on Greenhouse/Lever
  ["Pegasus Laboratories", "animal health"], ["Mixlab", "animal health"],
  ["Koala Health", "animal health"],
  // Home health / respiratory / DME
  ["Rotech Healthcare", "home health/dme"], ["Apria", "home health/dme"], ["VieMed", "home health/dme"],
  ["Quipt Home Medical", "home health/dme"], ["Drive DeVilbiss Healthcare", "home health/dme"], ["Fisher & Paykel Healthcare", "home health/dme"],
];

async function run() {
  console.log(`Starting employer discovery — ${TARGET_EMPLOYERS.length} candidate(s) in the target list.\n`);

  const { data: existing, error: existingErr } = await supabase
    .from("employers")
    .select("company_slug");
  if (existingErr) {
    console.error("Could not load existing employers:", existingErr.message);
    process.exit(1);
  }
  const existingSlugs = new Set((existing || []).map((e) => e.company_slug));

  let foundCount = 0;
  let notFoundCount = 0;
  let skippedCount = 0;

  for (const [name, industry] of TARGET_EMPLOYERS) {
    const candidates = slugCandidates(name);
    const primarySlug = candidates[0];
    if (existingSlugs.has(primarySlug) || candidates.some((c) => existingSlugs.has(c))) {
      skippedCount++;
      continue;
    }

    console.log(`Checking ${name}...`);
    let result = null;
    let atsType = null;

    result = await tryPlatform(fetchGreenhouseJobs, candidates);
    if (result) atsType = "greenhouse";

    if (!result) { result = await tryPlatform(fetchLeverJobs, candidates); if (result) atsType = "lever"; }
    if (!result) { result = await tryPlatform(fetchAshbyJobs, candidates); if (result) atsType = "ashby"; }
    if (!result) { result = await tryPlatform(fetchSmartRecruitersJobs, candidates); if (result) atsType = "smartrecruiters"; }
    if (!result) { result = await tryPlatform(fetchWorkableJobs, candidates); if (result) atsType = "workable"; }
    if (!result) { result = await tryWorkday(candidates); if (result) atsType = "workday"; }
    if (!result) { result = await tryPlatform(fetchIcimsJobs, candidates); if (result) atsType = "icims"; }
    if (!result) { result = await tryPlatform(fetchApplicantProJobs, candidates); if (result) atsType = "applicantpro"; }
    if (!result) { result = await tryPlatform(fetchJobviteJobs, candidates); if (result) atsType = "jobvite"; }
    if (!result) { result = await tryPlatform(fetchTeamtailorJobs, candidates); if (result) atsType = "teamtailor"; }
    if (!result) { result = await tryPlatform(fetchPinpointJobs, candidates); if (result) atsType = "pinpoint"; }
    if (!result) { result = await tryPlatform(fetchClinchTalentJobs, candidates); if (result) atsType = "clinchtalent"; }
    if (!result) { result = await tryPlatform(fetchDrupalCareersJobs, candidates); if (result) atsType = "drupalcareers"; }
    if (!result) { result = await tryPlatform(fetchTalentBrewJobs, candidates); if (result) atsType = "talentbrew"; }

    if (result) {
      const { error: insertErr } = await supabase
        .from("employers")
        .upsert(
          {
            company_name: name,
            company_slug: primarySlug,
            ats_type: atsType,
            ats_identifier: result.identifier,
            industry,
            active: true,
            priority: "normal",
          },
          { onConflict: "company_slug" }
        );
      if (insertErr) {
        console.error(`  Found on ${atsType} but could not save: ${insertErr.message}`);
      } else {
        console.log(`  FOUND — ${atsType}, identifier "${result.identifier}" (${result.jobCount} job(s) live right now)`);
        foundCount++;
      }
    } else {
      console.log(`  NOT FOUND on any supported platform — needs manual research or a new adapter.`);
      notFoundCount++;
    }
  }

  console.log(`\nDiscovery run complete. Found ${foundCount}, not found ${notFoundCount}, already known ${skippedCount}, out of ${TARGET_EMPLOYERS.length} candidate(s).`);
}

run();
