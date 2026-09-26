// Ingestion orchestrator
//
// For every active employer in the `employers` table, calls the right
// adapter, normalizes each job, and upserts it into `jobs`. Run this on a
// schedule (see README "Scheduling ingestion" section) — it is NOT wired
// to any HTTP route on purpose, since it shouldn't run on a page request.
//
// Usage: node backend/ingest.js

require("dotenv").config();
const { metric } = require('./ingestRunMetrics');
const { pruneTitleFilterRejections, titleLooksRelevantWithDiagnostics } = require('./titleFilterDiagnostics');
const { createClient } = require("@supabase/supabase-js");
const { mentionsNonUsCountry } = require("./matching");
const { safeEvaluateSocialEligibilityForIngestion } = require("./socialAutomation");
const { fetchGreenhouseJobs, normalizeGreenhouseJob } = require("./adapters/greenhouse");
const { fetchLeverJobs, normalizeLeverJob } = require("./adapters/lever");
const { fetchAshbyJobs, normalizeAshbyJob } = require("./adapters/ashby");
const { fetchWorkdayJobs, normalizeWorkdayJob, isLabcorpWorkdayCommercialTitle } = require("./adapters/workday");
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
const { fetchAemCareersJobs, normalizeAemCareersJob } = require("./adapters/aemcareers");
const { fetchKulaJobs, normalizeKulaJob } = require("./adapters/kula");
const { fetchAdpJobs }    = require("./adapters/adp");
const { fetchUkgJobs }    = require("./adapters/ukg");
const { fetchJazzHRJobs } = require("./adapters/jazzhr");
const { fetchSuccessFactorsJobs, normalizeSuccessFactorsJob } = require("./adapters/successfactors");
const { fetchCustomHtmlJobs, normalizeCustomHtmlJob, splitTerritoryOpenings } = require("./adapters/customHtml");
const reviewedHtmlSources = require("./customHtmlSources.json");
const { generateEmbedding } = require("./ai/embeddings");
const { deterministicJobAnalysis } = require('./deterministicJobAnalysis');
const { validateJobLocation } = require('./validateJobLocation');
const { geocodeLocation } = require('./geocoding');

async function allEmployerRows(queryPage, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await queryPage(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

// Use the SERVICE ROLE key here, never the anon key — ingestion writes
// to the jobs table and must bypass row-level security intentionally.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(options.signal ? [options.signal] : [])]) }) } }
);

async function ingestEmployer(employer) {
  const repairSourceOnly = process.env.ROOK_INGEST_REPAIR_SOURCE_ONLY === '1';
  const disableClosures = process.env.ROOK_INGEST_REPAIR_NO_CLOSURES === '1';
  console.log(`Syncing ${employer.company_name} (${employer.ats_type})...`);

  let rawJobs = [];
  let normalize;

  try {
    if (employer.ingestion_hold_reason) throw new Error("Source verification hold: " + employer.ingestion_hold_reason);
    if (employer.ats_type === "custom_html") {
      // Reviewed sources participate in normal scheduled runs. An explicit env
      // allowlist overrides the registry (an empty value disables every source).
      const enabledIds = (process.env.CUSTOM_HTML_EMPLOYER_IDS ?? Object.keys(reviewedHtmlSources).join(",")).split(",").map(id => id.trim());
      if (!enabledIds.includes(employer.id)) {
        console.log("  Skipping custom_html — employer is not enabled for this run");
        return { status: 'skipped' };
      }
      rawJobs = await fetchCustomHtmlJobs(employer);
      const splitIds = (process.env.CUSTOM_HTML_SPLIT_TERRITORIES_IDS ?? Object.keys(reviewedHtmlSources).filter(id => reviewedHtmlSources[id].splitTerritories).join(",")).split(",").map(id => id.trim());
      if (splitIds.includes(employer.id)) {
        rawJobs = splitTerritoryOpenings(rawJobs);
      }
      normalize = normalizeCustomHtmlJob;
    } else if (employer.ats_type === "greenhouse") {
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
    } else if (employer.ats_type === "adp") {
      // ADP Workforce Now and ADP Recruiting — normalize built into adapter
      rawJobs = await fetchAdpJobs(employer);
      normalize = (job) => job; // adapter returns already-normalized rows
    } else if (employer.ats_type === "ukg") {
      // UKG Pro (UltiPro) — normalize built into adapter
      rawJobs = await fetchUkgJobs(employer);
      normalize = (job) => job;
    } else if (employer.ats_type === "jazzhr") {
      // JazzHR / ApplyToJob — normalize built into adapter
      rawJobs = await fetchJazzHRJobs(employer);
      normalize = (job) => job;
    } else if (employer.ats_type === "aemcareers") {
      rawJobs = await fetchAemCareersJobs(employer.ats_identifier);
      normalize = normalizeAemCareersJob;
    } else if (employer.ats_type === "kula") {
      rawJobs = await fetchKulaJobs(employer.ats_identifier);
      normalize = normalizeKulaJob;
    } else if (employer.ats_type === "successfactors") {
      const host = employer.ats_identifier.replace(/^https?:\/\//, "").replace(/\/$/, "");
      rawJobs = await fetchSuccessFactorsJobs(employer.ats_identifier);
      normalize = (job) => normalizeSuccessFactorsJob(job, employer, host);
    } else {
      console.log(`  Skipping — no adapter for ats_type "${employer.ats_type}"`);
      return { status: 'skipped' };
    }
  } catch (err) {
    metric('source_failures');
    console.error(`  FAILED: ${err.message}`);
    await supabase
      .from("employers")
      .update({ sync_status: "error", last_checked_at: new Date().toISOString() })
      .eq("id", employer.id);
    return { status: 'failed', failure_stage: 'source', error: err.message };
  }

  const seenSourceIds = new Set();
  let savedCount = 0;
  let writeFailed = false;
  let nonUsSkippedCount = 0;
  let aiAnalyzedThisRun = 0;

  // Pre-fetched once per employer, not per job — social_eligible needs
  // to know whether a PRIOR run already analyzed this specific job,
  // since the AI analysis step itself only happens after the upsert
  // below (and only for jobs under this run's per-employer cap).
  const existingAnalysisRows = await allEmployerRows((start, end) => supabase
    .from("jobs")
    .select(employer.ats_type === "custom_html" ? "source_job_id, ai_analysis, job_embedding, extraction_evidence, title_original, description_text" : "source_job_id, ai_analysis, title_original, description_text")
    .eq("employer_id", employer.id)
    .not("ai_analysis", "is", null)
    .order("id")
    .range(start, end));
  const existingAiAnalysisBySourceId = new Map((existingAnalysisRows || []).map((r) => [r.source_job_id, r.ai_analysis]));
  const sharedAnalysisKey = j => `${j.extraction_evidence?.original_title || j.title_original}\n${j.description_text}`;
  const sharedCustomAnalysis = new Map((existingAnalysisRows || []).map(j => [sharedAnalysisKey(j), j]));
  const existingContentBySourceId = new Map((existingAnalysisRows || []).map(r => [r.source_job_id, r]));

  // All existing source IDs for this employer — used to detect new jobs
  // so first_seen_at is only set on insert, never overwritten on update.
  const existingSourceRows = await allEmployerRows((start, end) => supabase
    .from("jobs")
    .select("source_job_id, location_evidence, job_lat, job_lng, state")
    .eq("employer_id", employer.id)
    .order("id")
    .range(start, end));
  const existingLocations = new Map((existingSourceRows || []).map(r => [r.source_job_id,r]));
  const existingSourceIds = new Set((existingSourceRows || []).map((r) => r.source_job_id));
  const closeExcludedJob = async (sourceId) => {
    if (disableClosures) return;
    if (!existingSourceIds.has(sourceId)) return;
    const { data: closed, error } = await supabase.from('jobs').update({ status: 'closed' })
      .eq('employer_id', employer.id).eq('source_job_id', sourceId).eq('status','active').select('id');
    if (error) { metric('write_failures'); writeFailed = true; console.error(`  Could not close excluded job ${sourceId}: ${error.message}`); }
    else metric('closed', closed?.length || 0);
  };

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
  const AI_ANALYSIS_CAP_PER_EMPLOYER = repairSourceOnly ? 0 : 10;

  // Same shape of problem as the AI-analysis cap above, for a different
  // resource: validateJobLocation() geocodes any job whose location text
  // is new or changed (a cached, still-valid point from a PRIOR run is
  // reused instantly — see validateJobLocation.js — so this only counts
  // genuinely NEW geocode lookups). Every one of those lookups goes
  // through geocoding.js's fetchWithTimeout(), which is throttled to
  // Nominatim's ~1 request/second usage policy (MIN_DELAY_BETWEEN_CALLS_MS
  // = 1100ms) via a single counter SHARED ACROSS THE WHOLE PROCESS, not
  // per employer — so it's already a process-wide bottleneck even before
  // considering any one employer. Unlike AI analysis, this had no cap at
  // all: a never-synced employer with, say, 400 relevant jobs (all new,
  // so none can reuse a cached point) forces ~400 throttled calls in a
  // row — over 7 minutes on the throttle alone, for ONE employer, before
  // its fetch/adapter time or anything else is even counted. Capping
  // this the same way AI analysis is capped (save the job normally,
  // defer its geocoding to a later run) keeps one large or never-synced
  // employer from being able to consume most of a run's 25-minute time
  // budget by itself — see Nightly Ingestion Capacity Review,
  // Sept 2026, for the analysis that identified this as the main driver
  // of employers going un-synced despite the nightly schedule.
  const GEOCODE_CAP_PER_EMPLOYER = repairSourceOnly ? 0 : 40;
  let geocodeCallsThisRun = 0;
  let geocodeDeferredThisRun = 0;
  const cappedGeocode = async (text, opts) => {
    if (geocodeCallsThisRun >= GEOCODE_CAP_PER_EMPLOYER) {
      geocodeDeferredThisRun++;
      // Mirrors how validateJobLocation already treats a genuine geocode
      // failure (network error, no match) — see its `catch { return
      // cleared; }` — so a deferred-for-cap job is indistinguishable
      // from an ordinary transient failure: no coordinates are recorded
      // (never a stale/wrong point), and because the result isn't
      // marked "validated", it is NOT cached, so it's retried — and, if
      // capacity allows, resolved — on the very next run rather than
      // staying stuck.
      throw new Error("GEOCODE_CAP_REACHED — deferred to a later run");
    }
    geocodeCallsThisRun++;
    return geocodeLocation(text, opts);
  };

  for (const raw of rawJobs) {
    const job = normalize(raw, employer);

    // Relevance filter: a very rough first pass. Replace with real
    // classification once the normalization step (Phase 1.5) is built —
    // for now this just keeps obviously-unrelated roles out. Note: the
    // Workday and TalentBrew adapters already pre-filter by title before
    // returning rawJobs at all (see their file comments), so for those
    // sources this check rarely rejects anything further — it's still
    // the primary filter for Greenhouse/Lever/Ashby, which return every
    // raw posting unfiltered.
    const sourceSpecificRelevant = employer.ats_type === 'workday'
      && String(employer.ats_identifier || '').split('|')[0].toLowerCase() === 'labcorp'
      && isLabcorpWorkdayCommercialTitle(job.title_original);
    if (!sourceSpecificRelevant && !titleLooksRelevantWithDiagnostics(job.title_original, job)) {
      await closeExcludedJob(job.source_job_id);
      continue;
    }
    // An older version of the filter may have admitted this posting.
    // Only relevant IDs belong in the live snapshot; otherwise the
    // close-missing step below leaves newly excluded jobs active forever.
    seenSourceIds.add(job.source_job_id);

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
    Object.assign(job, await validateJobLocation(job, cappedGeocode, existingLocations.get(job.source_job_id)));
    if (job.location_evidence.status === 'foreign' || mentionsNonUsCountry(job.location_raw, null, job.title_original)) {
      nonUsSkippedCount++;
      // An old record must not remain active after its source establishes
      // that it is foreign. New foreign jobs are never inserted.
      if (!disableClosures && existingSourceIds.has(job.source_job_id)) {
        const {data: closed, error: closeError} = await supabase.from('jobs').update({location_raw: job.location_raw, job_lat: null, job_lng: null, state: null, location_evidence: job.location_evidence, status: 'closed'}).eq('employer_id', employer.id).eq('source_job_id', job.source_job_id).eq('status','active').select('id');
        if (closeError) { metric('write_failures'); writeFailed = true; console.error(`  Foreign location refresh failed: ${closeError.message}`); }
        else metric('closed', closed?.length || 0);
      }
      continue;
    }

    // Validate before saving, independently of the per-employer AI cap.
    // Replaces old coordinates even when location evidence is unresolved.
    const priorContent = existingContentBySourceId.get(job.source_job_id);
    if (priorContent && (priorContent.title_original !== job.title_original || priorContent.description_text !== job.description_text)) {
      job.ai_analysis = null;
      job.job_embedding = null;
      existingAiAnalysisBySourceId.delete(job.source_job_id);
    }

    // Territory children share unchanged requirements with their parent posting.
    // Reuse only exact original-title/description matches within this employer.
    if (job.source_type === 'custom_html' && !job.ai_analysis) {
      const shared = sharedCustomAnalysis.get(sharedAnalysisKey(job));
      if (shared?.ai_analysis) {
        job.ai_analysis = shared.ai_analysis;
        job.job_embedding = shared.job_embedding || null;
        existingAiAnalysisBySourceId.set(job.source_job_id, shared.ai_analysis);
      }
    }

    const payload = { ...job, last_seen_at: new Date().toISOString(), social_eligible: safeEvaluateSocialEligibilityForIngestion({ ...job, ai_analysis: existingAiAnalysisBySourceId.get(job.source_job_id) || null }) };
    const known = existingSourceIds.has(job.source_job_id);
    let inserted = false;
    let response;
    if (!known) {
      response = await supabase.from('jobs').insert({ ...payload, first_seen_at: new Date().toISOString() }).select().single();
      inserted = !response.error;
      if (response.error?.code === '23505') response = await supabase.from('jobs').upsert(payload, { onConflict: 'employer_id,source_job_id', ignoreDuplicates: false }).select().single();
    } else response = await supabase.from('jobs').upsert(payload, { onConflict: 'employer_id,source_job_id', ignoreDuplicates: false }).select().single();
    const { data: upsertedRow, error } = response;

    if (error) {
      writeFailed = true; metric('write_failures');
      console.error(`  Upsert error for "${job.title_original}": ${error.message}`);
      continue;
    }
    savedCount++;
    metric(inserted ? 'inserted' : 'updated');
    existingSourceIds.add(job.source_job_id);

    if (job.status !== "active") continue;

    // Obvious sales titles receive conservative deterministic enrichment.
    // Ambiguous but relevant titles stay saved with analysis deferred; a
    // missing external AI service must never reject or close a source job.
    if (!upsertedRow.ai_analysis) {
      const analysis = deterministicJobAnalysis({
        title: upsertedRow.title_original,
        description: upsertedRow.description_text,
        employerIndustry: upsertedRow.industry || employer.industry,
      });
      if (analysis) {
        // Re-evaluated now that a real category mapping may exist for
        // the first time — without this, a brand-new job would stay
        // social_eligible=false until an entire separate re-ingestion
        // run re-upserts it, even though it's fully analyzable right
        // now, this run.
        const nowEligible = safeEvaluateSocialEligibilityForIngestion({ ...upsertedRow, ai_analysis: analysis });
        const { error: analysisError } = await supabase.from("jobs").update({ ai_analysis: analysis, social_eligible: nowEligible }).eq("id", upsertedRow.id);
        if (analysisError) { metric('write_failures'); writeFailed = true; }
      }
    }

    // Embeddings still use their existing independent provider. Keep the
    // per-employer cap for that paid/network operation; deterministic title
    // enrichment above is local and is applied to every obvious sales job.
    if (aiAnalyzedThisRun >= AI_ANALYSIS_CAP_PER_EMPLOYER) continue;
    aiAnalyzedThisRun++;

    if (!upsertedRow.job_embedding) {
      try {
        const embeddingText = `${upsertedRow.title_original || ""}\n\n${upsertedRow.description_text || ""}`.trim();
        const embedding = await generateEmbedding(embeddingText);
        const { error: embeddingWriteError } = await supabase.from("jobs").update({ job_embedding: embedding }).eq("id", upsertedRow.id);
        if (embeddingWriteError) { metric('write_failures'); writeFailed = true; throw embeddingWriteError; }
      } catch (err) {
        metric('embedding_failures');
        console.error(`  Embedding generation failed for "${job.title_original}": ${err.message}`);
      }
    }

  }

  // Mark jobs that disappeared from the source as closed, rather than
  // deleting them — see architecture spec section 3.
  const existingJobs = await allEmployerRows((start, end) => supabase
    .from("jobs")
    .select("id, source_job_id")
    .eq("employer_id", employer.id)
    .eq("status", "active")
    .order("id")
    .range(start, end));

  if (writeFailed) rawJobs.incompleteSnapshot = true;
  const closedIds = (rawJobs.incompleteSnapshot || disableClosures ? [] : (existingJobs || []))
    .filter((j) => !seenSourceIds.has(j.source_job_id))
    .map((j) => j.id);

  if (rawJobs.incompleteSnapshot) {
    metric('partial_snapshots');
    console.warn(`  Source snapshot was incomplete for ${employer.company_name}; existing jobs were preserved while current postings were refreshed.`);
  }

  if (closedIds.length) {
    const { data: actuallyClosed, error: closeError } = await supabase.from("jobs").update({ status: "closed" }).in("id", closedIds).eq("status", "active").select("id");
    if (closeError) { metric('write_failures'); throw closeError; }
    metric('closed', actuallyClosed?.length || 0);
  }

  const { error: employerStatusError } = await supabase
    .from("employers")
    .update({
      sync_status: rawJobs.incompleteSnapshot ? "partial" : "ok",
      last_checked_at: new Date().toISOString(),
      ...(rawJobs.incompleteSnapshot ? {} : { last_successful_sync_at: new Date().toISOString() }),
    })
    .eq("id", employer.id);

  if (employerStatusError) { metric('write_failures'); throw employerStatusError; }

  console.log(
    `  Done — ${savedCount} relevant job(s) saved (${rawJobs.length} total posting(s) examined), ${closedIds.length} closed, ${nonUsSkippedCount} non-US posting(s) skipped` +
      (geocodeDeferredThisRun > 0 ? `, ${geocodeDeferredThisRun} location lookup(s) deferred to a later run (per-employer geocode cap reached).` : `.`)
  );
  return { status: rawJobs.incompleteSnapshot ? 'partial' : 'completed', warnings: rawJobs.snapshotWarnings || [] };
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

// Guards against two overlapping `npm run ingest` invocations (e.g. a
// scheduled run that hasn't finished when the next one fires 30 minutes
// later). This is a plain conditional row UPDATE, not a Postgres
// session-scoped primitive like pg_advisory_lock — deliberately, since
// requests through Supabase's client go over pooled connections, and a
// session lock isn't guaranteed to be held by the same connection across
// separate calls the way this run needs it to be. See
// migration_ingestion_lock.sql for the one-row table this needs, which
// has NOT been created yet — this function fails OPEN (treats the lock
// as acquired) if that table doesn't exist, so deploying this code is
// safe before the migration is applied; it simply has no overlap
// protection until then.
const INGEST_LOCK_STALE_MS = 35 * 60 * 1000; // a little over DO's 30-min hard timeout, so a genuinely-killed run's lock doesn't block forever
const INGEST_LOCK_ROW_ID = 1;

async function tryAcquireIngestLock() {
  const staleBefore = new Date(Date.now() - INGEST_LOCK_STALE_MS).toISOString();
  const { data, error } = await supabase
    .from("ingestion_run_lock")
    .update({ locked_at: new Date().toISOString(), locked_by: `pid:${process.pid}` })
    .eq("id", INGEST_LOCK_ROW_ID)
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .select()
    .maybeSingle();
  if (error) {
    console.log(
      `  Ingestion lock unavailable (${error.message}) — proceeding without overlap protection. ` +
        `See migration_ingestion_lock.sql (not yet applied).`
    );
    return { acquired: true, failOpen: true };
  }
  return { acquired: !!data, failOpen: false };
}

async function releaseIngestLock() {
  try {
    await supabase.from("ingestion_run_lock").update({ locked_at: null, locked_by: null }).eq("id", INGEST_LOCK_ROW_ID);
  } catch {
    // Best-effort — if this fails, INGEST_LOCK_STALE_MS clears the lock
    // on its own the next time someone tries to acquire it.
  }
}

async function run(options = {}) {
  const startedAt = Date.now();

  // Optional: node backend/ingest.js <employer name or slug> runs the
  // sync for just that one employer instead of the full active list -
  // useful for verifying a specific fix without waiting on everyone
  // else's turn in the normal oldest-first order below.
  const employerFilter = process.argv[2];

  // A single-employer debug run is a manual, supervised invocation, not
  // the unattended scheduled job overlap protection exists for — skip
  // the lock for it entirely so it can never be blocked by, or block, a
  // real scheduled run.
  let lock = { acquired: true, failOpen: true };
  if (!employerFilter) {
    lock = await tryAcquireIngestLock();
    if (!lock.acquired) {
      console.log(
        "Another ingestion run appears to already be in progress (lock held and not stale) — " +
          "exiting without processing any employer."
      );
      return;
    }
  }

  try {
    await runEmployerLoop(startedAt, employerFilter, options);
  } finally {
    if (!employerFilter && !lock.failOpen) await releaseIngestLock();
  }
}

async function runEmployerLoop(startedAt, employerFilter, options = {}) {
  try {
    await pruneTitleFilterRejections(supabase);
  } catch (error) {
    // Missing/unavailable diagnostics storage must not block normal ingestion.
    console.error('INGEST_TITLE_FILTER_DIAGNOSTICS_PRUNE_FAILED', error.message);
  }

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
    throw new Error(error.message);
  }

  if (employerFilter && employers.length === 0) {
    console.error(`No active employer matched "${employerFilter}".`);
    throw new Error(`No active employer matched "${employerFilter}".`);
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

  const { randomUUID } = require('node:crypto');
  const runId = randomUUID();
  const entries = employers.map(e => ({ employer_id: e.id, name: e.company_name, status: 'not_reached' }));
  const summary = { employers: entries, totals: {}, counts_complete: true, manual: !!employerFilter };
  const started = new Date(startedAt).toISOString();
  const persist = async (status, ended = null) => {
    const { error } = await supabase.from('ingestion_runs').upsert({ id: runId, started_at: started, ended_at: ended, status, summary }, { onConflict: 'id' });
    if (error) throw new Error('Cannot persist ingestion run: ' + error.message);
  };
  await persist('running');
  const worker = options.worker || require('./ingestDeadline').boundedEmployer;
  let outcome = 'completed';
  try {
    for (let index = 0; index < employers.length; index++) {
      const remaining = TIME_BUDGET_MS - (Date.now() - startedAt);
      if (remaining < 5000) { outcome = 'budget_exhausted'; break; }
      const employer = employers[index], entry = entries[index];
      entry.status = 'running'; entry.started_at = new Date().toISOString();
      await persist('running');
      console.log('INGEST_EMPLOYER_START', JSON.stringify({ run_id: runId, employer_id: employer.id }));
      const result = await require('./ingestionRecovery').recoverEmployer(employer, Math.min(4 * 60 * 1000, remaining - 3000), worker);
      Object.assign(entry, result, { ended_at: new Date().toISOString() });
      if (result.counts_complete === false) summary.counts_complete = false;
      for (const [key, count] of Object.entries(result.metrics || {})) summary.totals[key] = (summary.totals[key] || 0) + count;
      if (['timeout','failed'].includes(result.status)) {
        outcome = 'completed_with_errors';
        const { error } = await supabase.from('employers').update({ sync_status: 'error', last_checked_at: entry.ended_at }).eq('id', employer.id);
        if (error) entry.status_write_error = error.message;
      }
      await persist('running');
      console.log('INGEST_EMPLOYER_END', JSON.stringify({ run_id: runId, ...entry }));
    }
  } catch (error) {
    outcome = 'failed'; summary.error = error.message;
    throw error;
  } finally {
    summary.attempted = entries.filter(e => e.status !== 'not_reached').length;
    summary.completed = entries.filter(e => ['completed','partial'].includes(e.status)).length;
    summary.failed = entries.filter(e => ['failed','timeout'].includes(e.status)).length;
    summary.skipped = entries.filter(e => e.status === 'skipped').length;
    summary.not_reached = entries.filter(e => e.status === 'not_reached').length;
    await persist(outcome, new Date().toISOString());
    console.log('INGEST_RUN_END', JSON.stringify({ run_id: runId, status: outcome, ...summary }));
  }
  const result = { run_id: runId, status: outcome, summary };
  // The independent web-service watchdog owns diagnosis and notifications;
  // those operations cannot extend this scheduled job's execution deadline.
  return result;

}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { ingestEmployer, run, runEmployerLoop, tryAcquireIngestLock, releaseIngestLock };
