// Archives (permanently deletes) jobs that have been closed for a long
// time — 90+ days since they were last confirmed live by either
// ingestion script. Raw row count in Postgres isn't dangerous by
// itself, and closed jobs already cost nothing at query time (every
// candidate-facing query already filters to status='active'), but they
// accumulate forever otherwise: storage, backup size, and index size
// all creep upward with no natural ceiling as ingestion keeps running
// week after week.
//
// Safe by design, built specifically to not corrupt the 30-day
// guarantee record:
//   - excellent_match_log.job_id is ON DELETE SET NULL, and the log
//     snapshots job_title/company_name at the moment a job qualifies —
//     deleting the underlying job row here does NOT lose or corrupt
//     anyone's permanent Excellent Match count, by design (see the
//     conversation that led to that fix).
//   - candidate_job_matches.job_id cascades on delete, which is
//     actually desirable here: stale score rows for jobs that have been
//     gone for 90+ days are meaningless clutter, not something worth
//     preserving, and this doubles as a secondary cleanup for that
//     table's own unbounded growth (candidates × jobs).
//   - Only ever touches status='closed' jobs — never active ones,
//     regardless of how old first_seen_at is.
//
// Usage: node backend/archiveOldJobs.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ARCHIVE_AFTER_DAYS = 90;
const BATCH_SIZE = 500;
const TIME_BUDGET_MS = 20 * 60 * 1000; // 20 min — same reasoning as precomputeScores.js's budget, comfortably under DigitalOcean's 30-min hard limit for Scheduled Jobs

async function run() {
  const startedAt = Date.now();
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  console.log(`Archiving jobs closed and unseen since before ${cutoff}...\n`);

  let totalDeleted = 0;
  for (;;) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      console.log(`\nTime budget reached — stopping cleanly. Remaining old jobs will be picked up next run.`);
      break;
    }

    // Select a batch of IDs first, then delete by ID — safer than a
    // single blind DELETE ... LIMIT (Postgres doesn't support LIMIT on
    // DELETE directly), and keeps each round trip small and quick.
    const { data: batch, error: selectError } = await supabase
      .from("jobs")
      .select("id")
      .eq("status", "closed")
      .lt("last_seen_at", cutoff)
      .limit(BATCH_SIZE);

    if (selectError) {
      console.error(`Could not select jobs to archive: ${selectError.message}`);
      break;
    }
    if (!batch || batch.length === 0) {
      console.log("No more old closed jobs to archive.");
      break;
    }

    const ids = batch.map((j) => j.id);
    const { error: deleteError } = await supabase
      .from("jobs")
      .delete()
      .in("id", ids);

    if (deleteError) {
      console.error(`Could not delete batch: ${deleteError.message}`);
      break;
    }

    totalDeleted += ids.length;
    console.log(`  Archived ${ids.length} job(s) (running total: ${totalDeleted})`);

    if (batch.length < BATCH_SIZE) {
      console.log("\nReached the end of eligible jobs this run.");
      break;
    }
  }

  console.log(`\nDone. ${totalDeleted} old closed job(s) permanently archived.`);
}

run();
