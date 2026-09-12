// Precomputed match scoring — the real fix for a bug where the dashboard
// only ever scored a small pre-fetched pool of jobs (originally 20, later
// raised to 1,500) BEFORE deciding what to show, meaning a candidate's
// genuinely best match could sit outside that window and never even get
// considered. Raising the pool size only pushed the ceiling higher, it
// didn't remove the underlying problem — at real scale (many employers,
// growing job volume, eventually more than one candidate), the only
// architecture that's genuinely unbounded is scoring ahead of time and
// storing the result, so a request just reads already-computed rows
// sorted by score directly from the database, with no in-memory JS pool
// size to outgrow.
//
// Scores are stored in candidate_job_matches (candidate_id, job_id) —
// one row per candidate×job pair. This module ONLY writes the scoring
// fields (overall_score, candidate_fit, preference_fit, recommendation,
// reasons, concerns, confidence, hard_disqualifier, scored_at) — it
// never touches dismissed/saved/generated_package, which are set by
// user actions elsewhere (backend/routes/jobs.js,
// backend/routes/applicationPackage.js). Supabase's upsert only writes
// the columns present in the payload, so those user-set fields are
// preserved automatically on conflict, not overwritten.

const { scoreJob } = require("../matching");
const { distanceMiles } = require("../geocoding");

// Increment whenever scoring logic changes requiring all stored scores
// to be refreshed. Dashboard compares profile.scoring_version to this
// and rescores immediately on next load if they don't match — no manual
// preference change needed after a scoring logic deploy.
// History:
//   1 — baseline
//   2 — industry matching switched from description_text to job.industry column
const CURRENT_SCORING_VERSION = 2;

// Maximum radius for scoring in-person roles.
// Remote jobs and jobs with no coordinates are always included.
const SCORE_RADIUS_MILES = 200;

const UPSERT_BATCH_SIZE = 500; // keeps individual requests to Supabase a reasonable size

/**
 * Score one candidate against every currently-active job, and store the
 * results. Safe to call repeatedly — always fully overwrites this
 * candidate's scoring fields with fresh values, never touches
 * saved/dismissed/generated_package.
 *
 * @param {object} supabase - a Supabase client with write access (service role)
 * @param {object} profile - a full candidate_profiles row (must include .id)
 * @returns {Promise<{scoredCount: number}>}
 */
// Active-jobs cache — 10 minute TTL, process-scoped.
// fetchActiveJobs does 17+ sequential Supabase round-trips (~3-5 s total
// at PAGE_SIZE=150). Pre-warmed on module load so the first onboarding
// preview request hits the cache rather than waiting 40+ seconds.
let _activeJobsListCache = null;
let _activeJobsListExpiry = 0;
// In-flight deduplication: if two callers (e.g. scoreAndStoreForCandidate
// and match-preview running simultaneously) both find a cold cache, the
// second waits for the first's fetch to complete rather than starting its
// own parallel 17-page fetch. Without this, two simultaneous cold calls
// each do the full sequential fetch independently — doubling the DB load
// and both taking 30-40s instead of one taking 30-40s and the other waiting.
let _activeJobsListInFlight = null;

async function fetchActiveJobs(supabase) {
  const now = Date.now();

  // Fresh cache hit
  if (_activeJobsListCache && now < _activeJobsListExpiry) return _activeJobsListCache;

  // Stale-while-revalidate: return the old list immediately, refresh in background.
  // This means no request ever blocks on a cold fetch after the first boot warm.
  if (_activeJobsListCache && !_activeJobsListInFlight) {
    console.log(`[fetchActiveJobs] stale — serving ${_activeJobsListCache.length} cached jobs, refreshing in background`);
    _activeJobsListInFlight = _doFetchActiveJobs(supabase).finally(() => { _activeJobsListInFlight = null; });
    return _activeJobsListCache;
  }

  // In-flight dedup: share one in-progress fetch
  if (_activeJobsListInFlight) return _activeJobsListInFlight;

  // No cache at all (first call) — must wait once
  _activeJobsListInFlight = _doFetchActiveJobs(supabase).finally(() => { _activeJobsListInFlight = null; });
  return _activeJobsListInFlight;
}

async function _doFetchActiveJobs(supabase) {
  // Paginated fetch — Supabase/PostgREST caps a single query at 1000
  // rows by default, and a plain .select("*") with no .range() silently
  // truncates rather than erroring. With ATS + Adzuna ingestion now
  // regularly producing more than 1000 active+approved jobs, that
  // default was silently excluding every job past the first 1000 from
  // ever being scored for anyone — no error, no warning, the run just
  // reported success against whatever 1000 happened to come back.
  // Reported symptom that led here: a specific real, approved job never
  // got scored no matter how many times precompute-scores was rerun.
  //
  // Column list trimmed to only what scoreJob() actually reads, and page
  // size dropped from 1000 to 300 — at ~2,500 active jobs, a full-row
  // (job_embedding vectors + full ai_analysis/description JSON) 1000-row
  // page was large enough to occasionally hit a real "upstream request
  // timeout" from Supabase. Smaller, narrower pages cost more round
  // trips but each one is far lighter, which is the right trade here —
  // this only runs on a schedule, not on a user-facing request path.
  // Page size dropped from 300 to 150 after a real "canceling statement
  // due to statement timeout" in production — later pages of a plain
  // OFFSET-based .range() scan past a growing number of rows before
  // Postgres can start returning results, and each row here is heavy
  // (description_text, ai_analysis JSON, job_embedding vectors). This
  // alone is a mitigation, not the real fix: the actual fix is a
  // composite index on (status, moderation_status, id) so Postgres can
  // seek straight to the right rows instead of scanning past others to
  // find them — see ROOK-Setup-Guide.pdf / ask Claude for the exact SQL.
  const PAGE_SIZE = 150;
  const JOB_COLUMNS = "id, title_original, description_text, location_raw, job_lat, job_lng, industry, compensation_text, salary_min, salary_max, ai_analysis, job_embedding, remote_status, travel_percentage, date_posted, last_seen_at";
  let activeJobs = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .order("id", { ascending: true }) // deterministic pagination — .range() without an explicit order is unreliable in Postgres and harder for the planner to use an index for
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not load active jobs: ${error.message}`);
    activeJobs = activeJobs.concat(page || []);
    if (!page || page.length < PAGE_SIZE) break; // last page reached
  }

  // Reported directly: "ON CONFLICT DO UPDATE command cannot affect
  // row a second time" — Postgres refusing a batch upsert that
  // contains the same (candidate_id, job_id) pair twice. Since job_id
  // is a genuine primary key, that can only happen if this fetch
  // itself returned the same job more than once (most plausible cause:
  // active jobs being ingested/closed concurrently while this
  // ~37-page scan was in progress can shift which rows fall in a given
  // .range() window between requests, occasionally overlapping two
  // pages on the same row). Deduplicating by id here is a robust fix
  // regardless of the exact mechanism - downstream scoring/upsert code
  // never has to handle this class of failure.
  const seen = new Set();
  const deduped = activeJobs.filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
  if (deduped.length !== activeJobs.length) {
    console.log(`  (removed ${activeJobs.length - deduped.length} duplicate job row(s) from pagination overlap)`);
  }
  // 60-minute TTL — stale-while-revalidate makes long TTL safe
  _activeJobsListCache = deduped;
  _activeJobsListExpiry = Date.now() + 60 * 60 * 1000;
  console.log(`[fetchActiveJobs] cache refreshed: ${deduped.length} jobs`);
  return deduped;
}

async function scoreAndStoreForCandidate(supabase, profile, activeJobs = null) {
  // activeJobs can be passed in by a caller that's scoring many
  // candidates in the same run (see precomputeScores.js) so the same
  // ~2,500-job list isn't re-fetched from scratch for every single
  // candidate — that redundant re-fetch was real, unnecessary load
  // directly contributing to the timeout above. A caller scoring just
  // one candidate on demand (the live-fallback path in
  // backend/routes/jobs.js) can omit it and this fetches for itself.
  const jobs = activeJobs || (await fetchActiveJobs(supabase));

  // Filter to jobs within radius (or remote / unknown location) when
  // the candidate has coordinates. Scoring 300-600 local jobs instead
  // of 5,000+ is the single largest performance win available here:
  // scoreJob() calls drop ~90%, upsert batches drop from ~11 to ~1,
  // and total scoring time drops from 3s to under 0.5s (warm cache).
  // Remote jobs and jobs with null coordinates are always included —
  // remote doesn't mean local, and unknown location is better included
  // than missed. Field jobs beyond the radius score poorly anyway
  // (distanceMultiplier ~0.25), so excluding them doesn't change what
  // the user would realistically act on.
  const hasHomeCoords = profile.home_lat != null && profile.home_lng != null;
  const jobsToScore = hasHomeCoords
    ? jobs.filter(job => {
        if (job.job_lat == null || job.job_lng == null) return true; // unknown location
        if (/remote/i.test(job.remote_status || '') || /remote/i.test(job.location_raw || '')) return true;
        return distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng) <= SCORE_RADIUS_MILES;
      })
    : jobs; // no home location — score everything as before

  console.log(`[scoreAndStore] candidate=${profile.id?.slice(0,8)} total_jobs=${jobs.length} jobs_to_score=${jobsToScore.length} has_coords=${hasHomeCoords}`);

  const now = new Date().toISOString();
  const rows = jobsToScore.map((job) => {
    const match = scoreJob(job, profile);
    return {
      candidate_id: profile.id,
      job_id: job.id,
      overall_score: match.overall_score,
      candidate_fit: match.candidate_fit,
      preference_fit: match.preference_fit,
      recommendation: match.recommendation,
      reasons: match.reasons,
      concerns: match.concerns,
      confidence: match.confidence,
      hard_disqualifier: match.hard_disqualifier,
      categories: match.categories,
      excellent_match: match.excellent_match,
      scored_at: now,
    };
  });

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error: upsertError } = await supabase
      .from("candidate_job_matches")
      .upsert(batch, { onConflict: "candidate_id,job_id" });
    if (upsertError) throw new Error(`Could not store scores (batch starting at ${i}): ${upsertError.message}`);
  }

  // Permanent record of every job that has EVER qualified as an
  // Excellent Match for this candidate — separate from the live
  // candidate_job_matches.excellent_match flag above, which reflects
  // only the CURRENT score and can flip if a job gets rescored later
  // (job data changes, or the matching logic itself gets tuned, which
  // happened many times over the course of one evening building this).
  // Without this, the guarantee count a candidate sees could silently
  // go down over time even though they genuinely were shown 5 Excellent
  // Matches earlier — exactly the kind of thing that turns into an
  // unresolvable "I saw 5, your system says 3" dispute. Insert-only,
  // never updated or deleted once a job first qualifies.
  //
  // Job title/company are snapshotted here rather than joined from the
  // live jobs table at read time, and job_id's foreign key is
  // ON DELETE SET NULL rather than CASCADE — jobs are normally only
  // ever marked status='closed', never actually deleted, but if a job
  // row were ever genuinely deleted (a manual cleanup, for instance), a
  // CASCADE would have silently deleted this log entry too and dropped
  // the candidate's count. This makes the log fully self-contained and
  // immune to that.
  const newlyExcellent = rows
    .filter((r) => r.excellent_match)
    .map((r) => {
      const job = jobs.find((j) => j.id === r.job_id);
      return {
        candidate_id: r.candidate_id,
        job_id: r.job_id,
        job_title: job?.title_original || null,
        company_name: job?.company_name || null,
      };
    });
  if (newlyExcellent.length > 0) {
    const { error: logError } = await supabase
      .from("excellent_match_log")
      .upsert(newlyExcellent, { onConflict: "candidate_id,job_id", ignoreDuplicates: true });
    if (logError) console.error(`Could not update excellent_match_log for candidate ${profile.id}: ${logError.message}`);
  }

  // Marks when this candidate was last fully scored, so a time-boxed
  // precompute run (see precomputeScores.js) can order candidates
  // oldest-scored-first and always make real progress on whoever's most
  // overdue — same "keep track of where you left off" principle already
  // used for employers in ingest.js. Best-effort: if this update fails,
  // scoring itself already succeeded and was already returned above, so
  // this doesn't throw and undo that.
  const { error: markError } = await supabase
    .from("candidate_profiles")
    .update({ last_scored_at: now, scoring_version: CURRENT_SCORING_VERSION })
    .eq("id", profile.id);
  if (markError) console.error(`Could not update last_scored_at for candidate ${profile.id}: ${markError.message}`);

  return { scoredCount: rows.length };
}

module.exports = { scoreAndStoreForCandidate, fetchActiveJobs, CURRENT_SCORING_VERSION };
