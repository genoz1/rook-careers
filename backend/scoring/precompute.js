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
async function scoreAndStoreForCandidate(supabase, profile) {
  const { data: activeJobs, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "active");

  if (error) throw new Error(`Could not load active jobs: ${error.message}`);

  const now = new Date().toISOString();
  const rows = (activeJobs || []).map((job) => {
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

  return { scoredCount: rows.length };
}

module.exports = { scoreAndStoreForCandidate };
