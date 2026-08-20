// Runnable script for the daily match-email digest. Meant to run once a
// day via a DigitalOcean Scheduled Job (npm run send-digest), same
// pattern as backend/ingest.js's every-6-hours job.
//
// One candidate's send failing (bad email, Resend hiccup, etc.) doesn't
// stop the run for everyone else — same resilience philosophy as
// ingest.js's per-employer error handling.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { sendDigestForCandidate } = require("./email/dailyDigest");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const APP_BASE_URL = process.env.PUBLIC_APP_URL || "https://seashell-app-hbjuo.ondigitalocean.app";

async function run() {
  const { data: profiles, error } = await supabase
    .from("candidate_profiles")
    .select("*")
    .not("email", "is", null);

  if (error) {
    console.error("Could not load candidate profiles:", error.message);
    process.exit(1);
  }

  console.log(`Found ${profiles.length} candidate(s) with an email on file.\n`);

  let sentCount = 0;
  let skippedCount = 0;

  for (const profile of profiles) {
    try {
      const result = await sendDigestForCandidate(supabase, profile, APP_BASE_URL);
      if (result.sent) {
        sentCount++;
        console.log(`  Sent to ${profile.email} — ${result.jobCount} job(s)`);
        await supabase
          .from("candidate_profiles")
          .update({ last_digest_sent_at: new Date().toISOString() })
          .eq("id", profile.id);
      } else {
        skippedCount++;
        console.log(`  Skipped ${profile.email} — ${result.reason}`);
      }
    } catch (err) {
      console.error(`  FAILED for ${profile.email}: ${err.message}`);
    }
  }

  console.log(`\nDigest run complete. Sent ${sentCount}, skipped ${skippedCount}, out of ${profiles.length} candidate(s).`);
}

run();
