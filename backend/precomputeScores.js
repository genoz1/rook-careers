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
const { scoreAndStoreForCandidate } = require("./scoring/precompute");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  const { data: profiles, error } = await supabase
    .from("candidate_profiles")
    .select("*");

  if (error) {
    console.error("Could not load candidate profiles:", error.message);
    process.exit(1);
  }

  console.log(`Found ${profiles.length} candidate profile(s) to score.\n`);

  let successCount = 0;
  for (const profile of profiles) {
    try {
      const result = await scoreAndStoreForCandidate(supabase, profile);
      successCount++;
      console.log(`  Scored ${profile.email || profile.id} against ${result.scoredCount} active job(s)`);
    } catch (err) {
      console.error(`  FAILED for ${profile.email || profile.id}: ${err.message}`);
    }
  }

  console.log(`\nPrecompute run complete. Scored ${successCount} / ${profiles.length} candidate(s).`);
}

run();
