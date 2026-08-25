// Runnable script for precomputed match scoring across every candidate.
// Meant to run on a schedule via a DigitalOcean Scheduled Job (npm run
// precompute-scores), same pattern as ingest.js and sendDigest.js.
//
// Cheap to run often — unlike ingestion (real network calls to employer
// ATS's) or the digest (real AI/email calls), this is pure computation
// (backend/matching.js has no I/O), so running this hourly or even more
// often is fine cost-wise. A reasonable cadence: right after each
// ingestion run finishes, so freshly-ingested jobs get scored promptly
// rather than sitting unscored until some separate schedule catches up.
//
// One candidate's scoring failing doesn't stop the run for everyone else
// — same resilience pattern as every other scheduled script here.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { scoreAndStoreForCandidate, fetchActiveJobs } = require("./scoring/precompute");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Same reasoning as ingest.js's identical constant: DigitalOcean's App
// Platform Scheduled Jobs have a hard 30-minute timeout that force-kills
// a run mid-request rather than exiting cleanly. At a couple hundred
// candidates × a growing job pool (already ~2,500 and climbing with
// regular Adzuna ingestion), a full pass across every candidate can
// genuinely approach or exceed that. This budget stops the run cleanly
// with time to spare — nothing is corrupted either way (each candidate's
// scores are written before moving to the next), it just means a full
// pass across every candidate may take more than one scheduled run to
// complete, with candidates ordered oldest-scored-first so each run
// makes real progress on whoever's most overdue rather than repeatedly
// stalling on the same candidates at the end of an arbitrary list order.
const TIME_BUDGET_MS = 25 * 60 * 1000; // 25 min — 5 min of buffer under DO's 30-min hard limit

async function run() {
  const startedAt = Date.now();

  // Oldest-scored-first (nulls/never-scored first) — a brand-new
  // candidate who's never been scored at all takes priority over one
  // who was scored yesterday.
  const { data: profiles, error } = await supabase
    .from("candidate_profiles")
    .select("*")
    .order("last_scored_at", { ascending: true, nullsFirst: true });

  if (error) {
    console.error("Could not load candidate profiles:", error.message);
    process.exit(1);
  }

  console.log(`Found ${profiles.length} candidate profile(s) to score.\n`);

  // Fetched ONCE and shared across every candidate in this run, rather
  // than each candidate independently re-fetching the same job list from
  // scratch.
  console.log("Loading active jobs...");
  const activeJobs = await fetchActiveJobs(supabase);
  console.log(`Loaded ${activeJobs.length} active job(s).\n`);

  let successCount = 0;
  let processedCount = 0;
  for (const profile of profiles) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > TIME_BUDGET_MS) {
      const remaining = profiles.length - processedCount;
      console.log(
        `\nTime budget reached (${Math.round(elapsed / 60000)} min) — stopping cleanly. ` +
          `${remaining} candidate(s) not reached this run; they're now oldest-scored (or never-scored), ` +
          `so they'll be prioritized on the next run.`
      );
      break;
    }
    try {
      const result = await scoreAndStoreForCandidate(supabase, profile, activeJobs);
      successCount++;
      console.log(`  Scored ${profile.email || profile.id} against ${result.scoredCount} active job(s)`);
    } catch (err) {
      console.error(`  FAILED for ${profile.email || profile.id}: ${err.message}`);
    }
    processedCount++;
  }

  console.log(`\nPrecompute run complete. Scored ${successCount} / ${profiles.length} candidate(s).`);
}

run();
