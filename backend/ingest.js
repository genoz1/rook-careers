// Ingestion orchestrator
//
// For every active employer in the `employers` table, calls the right
// adapter, normalizes each job, and upserts it into `jobs`. Run this on a
// schedule (see README "Scheduling ingestion" section) — it is NOT wired
// to any HTTP route on purpose, since it shouldn't run on a page request.
//
// Usage: node backend/ingest.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { mentionsNonUsCountry } = require("./matching");
const { fetchGreenhouseJobs, normalizeGreenhouseJob } = require("./adapters/greenhouse");
const { fetchLeverJobs, normalizeLeverJob } = require("./adapters/lever");
const { fetchAshbyJobs, normalizeAshbyJob } = require("./adapters/ashby");
const { fetchWorkdayJobs, normalizeWorkdayJob } = require("./adapters/workday");
const { fetchTalentBrewJobs, normalizeTalentBrewJob } = require("./adapters/talentbrew");
const { fetchWorkableJobs, normalizeWorkableJob } = require("./adapters/workable");
const { fetchSmartRecruitersJobs, normalizeSmartRecruitersJob } = require("./adapters/smartrecruiters");
const { fetchClinchTalentJobs, normalizeClinchTalentJob } = require("./adapters/clinchtalent");
const { fetchOracleHcmJobs, normalizeOracleHcmJob } = require("./adapters/oraclehcm");
const { fetchPhenomJobs, normalizePhenomJob } = require("./adapters/phenom");
const { fetchJobviteJobs, normalizeJobviteJob } = require("./adapters/jobvite");
const { fetchApplicantProJobs, normalizeApplicantProJob } = require("./adapters/applicantpro");
const { fetchIcimsJobs, normalizeIcimsJob } = require("./adapters/icims");
const { fetchDrupalCareersJobs, normalizeDrupalCareersJob } = require("./adapters/drupalcareers");
const { fetchTeamtailorJobs, normalizeTeamtailorJob } = require("./adapters/teamtailor");
const { fetchPinpointJobs, normalizePinpointJob } = require("./adapters/pinpoint");
const { fetchEightfoldJobs, normalizeEightfoldJob } = require("./adapters/eightfold");
const { fetchPaylocityJobs, normalizePaylocityJob } = require("./adapters/paylocity");
const { analyzeJob } = require("./ai/jobAnalysis");
const { generateEmbedding } = require("./ai/embeddings");
const { geocodeLocation } = require("./geocoding");

// Use the SERVICE ROLE key here, never the anon key — ingestion writes
// to the jobs table and must bypass row-level security intentionally.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function ingestEmployer(employer) {
  console.log(`Syncing ${employer.company_name} (${employer.ats_type})...`);

  let rawJobs = [];
  let normalize;

  try {
    if (employer.ats_type === "greenhouse") {
      rawJobs = await fetchGreenhouseJobs(employer.ats_identifier);
      normalize = normalizeGreenhouseJob;
    } else if (employer.ats_type === "lever") {
      rawJobs = await fetchLeverJobs(employer.ats_identifier);
      normalize = normalizeLeverJob;
    } else if (employer.ats_type === "ashby") {
      rawJobs = await fetchAshbyJobs(employer.ats_identifier);
      normalize = normalizeAshbyJob;
    } else if (employer.ats_type === "workday") {
      rawJobs = await fetchWorkdayJobs(employer.ats_identifier);
      normalize = normalizeWorkdayJob;
    } else if (employer.ats_type === "talentbrew") {
      rawJobs = await fetchTalentBrewJobs(employer.ats_identifier);
      normalize = normalizeTalentBrewJob;
    } else if (employer.ats_type === "workable") {
      rawJobs = await fetchWorkableJobs(employer.ats_identifier);
      normalize = normalizeWorkableJob;
    } else if (employer.ats_type === "smartrecruiters") {
      rawJobs = await fetchSmartRecruitersJobs(employer.ats_identifier);
      normalize = normalizeSmartRecruitersJob;
    } else if (employer.ats_type === "clinchtalent") {
      rawJobs = await fetchClinchTalentJobs(employer.ats_identifier);
      normalize = normalizeClinchTalentJob;
    } else if (employer.ats_type === "oraclehcm") {
      rawJobs = await fetchOracleHcmJobs(employer.ats_identifier);
      normalize = normalizeOracleHcmJob;
    } else if (employer.ats_type === "phenom") {
      rawJobs = await fetchPhenomJobs(employer.ats_identifier);
      normalize = normalizePhenomJob;
    } else if (employer.ats_type === "jobvite") {
      rawJobs = await fetchJobviteJobs(employer.ats_identifier);
      normalize = normalizeJobviteJob;
    } else if (employer.ats_type === "applicantpro") {
      rawJobs = await fetchApplicantProJobs(employer.ats_identifier);
      normalize = normalizeApplicantProJob;
    } else if (employer.ats_type === "icims") {
      rawJobs = await fetchIcimsJobs(employer.ats_identifier);
      normalize = normalizeIcimsJob;
    } else if (employer.ats_type === "drupalcareers") {
      rawJobs = await fetchDrupalCareersJobs(employer.ats_identifier);
      normalize = normalizeDrupalCareersJob;
    } else if (employer.ats_type === "teamtailor") {
      rawJobs = await fetchTeamtailorJobs(employer.ats_identifier);
      normalize = normalizeTeamtailorJob;
    } else if (employer.ats_type === "pinpoint") {
      rawJobs = await fetchPinpointJobs(employer.ats_identifier);
      normalize = normalizePinpointJob;
    } else if (employer.ats_type === "eightfold") {
      rawJobs = await fetchEightfoldJobs(employer.ats_identifier);
      normalize = normalizeEightfoldJob;
    } else if (employer.ats_type === "paylocity") {
      rawJobs = await fetchPaylocityJobs(employer.ats_identifier);
      normalize = normalizePaylocityJob;
    } else {
      console.log(`  Skipping — no adapter for ats_type "${employer.ats_type}"`);
      return;
    }
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    await supabase
      .from("employers")
      .update({ sync_status: "error", last_checked_at: new Date().toISOString() })
      .eq("id", employer.id);
    return;
  }

  const seenSourceIds = new Set();
  let savedCount = 0;
  let nonUsSkippedCount = 0;
  let aiAnalyzedThisRun = 0;

  // Cap how many NEW AI analyses (job analysis + embedding) happen per
  // employer per run. Some employers post hundreds of relevant jobs
  // (Abbott alone had 559 in one run) — without a cap, a single massive
  // employer can make one `npm run ingest` invocation take hours. Jobs
  // beyond the cap are still saved normally, just without AI analysis
  // yet; because that analysis is only ever attempted for jobs missing
  // it (see the `if (!upsertedRow.ai_analysis)` check below), the next
  // run picks up exactly where this one left off — no progress is lost,
  // it just spreads a big employer's backfill across a few runs.
  //
  // Lowered from 40 to 10 this session: the employer list roughly
  // doubled (100 -> 206) in one sitting, mostly brand-new employers
  // that have never been synced at all. With the higher cap, a single
  // large employer's AI analysis (a real Claude API call per job) ate
  // most of a run's time budget, so only 1-2 employers got touched per
  // run - a very slow way to catch up on ~110 never-synced employers.
  // At 10, more employers get through the listing/saving phase per
  // run even if their own AI scoring lags a run or two behind; revisit
  // raising this back up once the backlog of never-synced employers is
  // cleared.
  const AI_ANALYSIS_CAP_PER_EMPLOYER = 10;

  for (const raw of rawJobs) {
    const job = normalize(raw, employer);
    seenSourceIds.add(job.source_job_id);

    // Relevance filter: a very rough first pass. Replace with real
    // classification once the normalization step (Phase 1.5) is built —
    // for now this just keeps obviously-unrelated roles out. Note: the
    // Workday and TalentBrew adapters already pre-filter by title before
    // returning rawJobs at all (see their file comments), so for those
    // sources this check rarely rejects anything further — it's still
    // the primary filter for Greenhouse/Lever/Ashby, which return every
    // raw posting unfiltered.
    if (!looksRelevant(job.title_original)) continue;

    // Hard filter, not just a scoring-time penalty: ROOK is a US-focused
    // platform, and several employers added this session are large
    // multinationals (Danaher, UCB, Straumann, etc.) whose ATS boards
    // include worldwide postings. Reported directly as a concern once
    // the employer list started growing to include these. Reuses the
    // exact same detection matching.js already applies at scoring time
    // (checked against location_raw specifically, not the full
    // description, to keep false-positive risk low) so a foreign
    // posting is never stored at all, rather than relying on every
    // downstream reader (dashboard, digest, search) to correctly
    // demote it after the fact.
    if (mentionsNonUsCountry(job.location_raw)) {
      nonUsSkippedCount++;
      continue;
    }

    const { data: upsertedRow, error } = await supabase
      .from("jobs")
      .upsert(
        { ...job, last_seen_at: new Date().toISOString() },
        { onConflict: "employer_id,source_job_id" }
      )
      .select()
      .single();

    if (error) {
      console.error(`  Upsert error for "${job.title_original}": ${error.message}`);
      continue;
    }
    savedCount++;

    if (aiAnalyzedThisRun >= AI_ANALYSIS_CAP_PER_EMPLOYER) {
      continue; // saved, but AI analysis deferred to a later run
    }

    // AI job analysis + embedding both run once per job, ever — not on
    // every re-ingestion run. This keeps API cost bounded: a job already
    // analyzed on a previous run is skipped even if it's seen again
    // today. A failure here doesn't affect the job being saved — it
    // just means that job scores without the AI-derived factors until a
    // later run retries it.
    if (!upsertedRow.ai_analysis) {
      aiAnalyzedThisRun++;
      if (aiAnalyzedThisRun % 5 === 0 || aiAnalyzedThisRun === 1) {
        console.log(`    ...AI-analyzing job ${aiAnalyzedThisRun}/${AI_ANALYSIS_CAP_PER_EMPLOYER} this run: "${job.title_original}"`);
      }
      try {
        const analysis = await analyzeJob(upsertedRow.title_original, upsertedRow.description_text);
        await supabase.from("jobs").update({ ai_analysis: analysis }).eq("id", upsertedRow.id);
      } catch (err) {
        console.error(`  AI analysis failed for "${job.title_original}": ${err.message}`);
      }
    }

    if (!upsertedRow.job_embedding) {
      try {
        const embeddingText = `${upsertedRow.title_original || ""}\n\n${upsertedRow.description_text || ""}`.trim();
        const embedding = await generateEmbedding(embeddingText);
        await supabase.from("jobs").update({ job_embedding: embedding }).eq("id", upsertedRow.id);
      } catch (err) {
        console.error(`  Embedding generation failed for "${job.title_original}": ${err.message}`);
      }
    }

    if (upsertedRow.job_lat == null && upsertedRow.location_raw) {
      try {
        const coords = await geocodeLocation(upsertedRow.location_raw);
        if (coords) {
          await supabase.from("jobs").update({ job_lat: coords.lat, job_lng: coords.lng }).eq("id", upsertedRow.id);
        }
        // A null result (e.g. messy location text like "Multiple US
        // Locations" that Nominatim can't resolve) is expected and fine
        // — proximity scoring is a bonus on top of state-matching, not a
        // requirement, so a job with no coordinates just doesn't get
        // that bonus rather than breaking anything.
      } catch (err) {
        console.error(`  Geocoding failed for "${job.location_raw}": ${err.message}`);
      }
    }
  }

  // Mark jobs that disappeared from the source as closed, rather than
  // deleting them — see architecture spec section 3.
  const { data: existingJobs } = await supabase
    .from("jobs")
    .select("id, source_job_id")
    .eq("employer_id", employer.id)
    .eq("status", "active");

  const closedIds = (existingJobs || [])
    .filter((j) => !seenSourceIds.has(j.source_job_id))
    .map((j) => j.id);

  if (closedIds.length) {
    await supabase.from("jobs").update({ status: "closed" }).in("id", closedIds);
  }

  await supabase
    .from("employers")
    .update({
      sync_status: "ok",
      last_checked_at: new Date().toISOString(),
      last_successful_sync_at: new Date().toISOString(),
    })
    .eq("id", employer.id);

  console.log(
    `  Done — ${savedCount} relevant job(s) saved (${rawJobs.length} total posting(s) examined), ${closedIds.length} closed, ${nonUsSkippedCount} non-US posting(s) skipped.`
  );
}

// Relevance filter — still a placeholder pending real AI classification
// (architecture spec section 18), but this is a meaningful improvement
// over a flat keyword list: single generic words like "specialist" or
// "representative" match almost anything (Packaging Specialist, Customer
// Service Representative), so those only count when paired with a word
// that actually signals a sales/commercial role. A few standalone phrases
// are strong enough signals on their own.
//
// Known remaining limitation: a bare domain word like "veterinary" paired
// with "representative" can still let through non-sales roles inside a
// veterinary organization (e.g. a front-desk client service rep at a vet
// clinic) — genuinely distinguishing those from a sales-facing "Veterinary
// Territory Manager" needs real classification, not keyword matching.
const { titleLooksRelevant: looksRelevant } = require('./relevanceFilter');

// DigitalOcean's App Platform Scheduled Jobs have a hard 30-minute
// timeout — a run that hits it gets forcibly killed mid-request rather
// than exiting cleanly. With employers this large (Illumina, Roche,
// Genentech, Abbott, GE HealthCare can each have hundreds to thousands
// of postings), a full pass across every employer can genuinely exceed
// that. This budget makes the run stop itself cleanly with time to
// spare, rather than getting cut off abruptly — nothing is corrupted
// either way (progress is saved per-job throughout, not batched at the
// end), but a clean stop logs which employers were skipped instead of
// just vanishing mid-request.
const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 min — 5 min of buffer under DO's 30-min hard limit

async function run() {
  const startedAt = Date.now();

  // Optional: node backend/ingest.js <employer name or slug> runs the
  // sync for just that one employer instead of the full active list -
  // useful for verifying a specific fix without waiting on everyone
  // else's turn in the normal oldest-first order below.
  const employerFilter = process.argv[2];

  // Order by last_checked_at ascending (nulls first) rather than
  // whatever order the table happens to return — this means employers
  // that have never synced, or synced longest ago, get processed first.
  // If the time budget cuts a run short, it's a different employer that
  // gets skipped each time, not always the same ones at the end of an
  // arbitrary list order.
  let employerQuery = supabase
    .from("employers")
    .select("*")
    .eq("active", true)
    .order("last_checked_at", { ascending: true, nullsFirst: true });
  if (employerFilter) {
    employerQuery = employerQuery.or(`company_name.ilike.%${employerFilter}%,company_slug.ilike.%${employerFilter}%`);
  }
  const { data: employers, error } = await employerQuery;

  if (error) {
    console.error("Could not load employers:", error.message);
    process.exit(1);
  }

  if (employerFilter && employers.length === 0) {
    console.error(`No active employer matched "${employerFilter}".`);
    process.exit(1);
  }

  console.log(`Found ${employers.length} active employer(s) to sync.\n`);

  // Reported directly as a real need: with the employer list roughly
  // doubling in one session (mostly never-synced employers), the ingest
  // schedule was temporarily tightened to run every 30 minutes instead
  // of every 6 hours to burn through that backlog faster. This makes
  // "is the backlog actually cleared yet" visible in Runtime Logs
  // directly, rather than something that has to be checked manually via
  // a SQL query — once every employer has synced at least once, this
  // logs a clear, hard-to-miss signal that it's safe to dial the
  // schedule back down to its normal cadence.
  const neverSyncedCount = employers.filter((e) => !e.last_checked_at).length;
  if (neverSyncedCount > 0) {
    console.log(`BACKLOG: ${neverSyncedCount} employer(s) have never been synced yet.\n`);
  } else {
    console.log(
      "\n=========================================================\n" +
      "BACKLOG CLEARED — every active employer has synced at least\n" +
      "once. Safe to change the Job Trigger schedule back to its\n" +
      "normal cadence (e.g. 0 */6 * * *) instead of running every\n" +
      "30 minutes.\n" +
      "=========================================================\n"
    );
  }

  let processedCount = 0;
  for (const employer of employers) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > TIME_BUDGET_MS) {
      const remaining = employers.length - processedCount;
      console.log(
        `\nTime budget reached (${Math.round(elapsed / 60000)} min) — stopping cleanly. ` +
          `${remaining} employer(s) not reached this run; they're now oldest-synced, so they'll be ` +
          `prioritized on the next run.`
      );
      break;
    }
    await ingestEmployer(employer);
    processedCount++;
  }

  console.log(`\nIngestion run complete. Processed ${processedCount} / ${employers.length} employer(s).`);
}

run();
