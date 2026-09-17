#!/usr/bin/env node
// backend/scripts/backfillMissingAiAnalysis.js
//
// One-time (and reusable) catch-up for active jobs that never got AI
// analysis at all. Root cause: regular ingestion caps AI analysis at
// AI_ANALYSIS_CAP_PER_EMPLOYER (10) per employer, per run — for a
// high-volume employer whose job count regularly exceeds that, new
// unanalyzed postings can arrive faster than the cap clears the
// backlog, so it never fully catches up (confirmed directly: Philips
// alone had 71 active jobs with no AI analysis at all when this was
// investigated). This script has NO per-employer cap — it processes
// every active job with missing analysis, in batches, regardless of
// which employer they belong to.
//
// Cost note: each call is one short Claude prompt against a single job
// posting (see backend/ai/jobAnalysis.js) — negligible cost even across
// several hundred jobs, unlike a geocoding or scraping bill would be.
//
// Uses the exact same analyzeJob() function as regular ingestion — this
// does not duplicate or diverge from that logic in any way, and does
// NOT touch ingest.js, the per-run cap, matching.js, or scoring.
//
// THREE MODES:
//   1. DRY RUN (default) — counts and lists affected jobs, zero writes.
//   2. WRITE (--write --confirm) — actually calls analyzeJob() for each
//      job found and writes the result, exactly like ingestion would.
//      Also re-applies the same "no sales signals -> mark closed" rule
//      ingest.js already uses, so this stays consistent with normal
//      ingestion behavior rather than introducing a second standard.
//   3. No rollback mode — there's nothing destructive to undo here;
//      re-running --write again simply finds fewer (or zero) jobs left
//      to process, since already-analyzed jobs are skipped.
//
// Can be re-run any time — safe to use as the recurring "going forward"
// catch-up, independent of the regular ingestion cap.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { analyzeJob } = require("../ai/jobAnalysis");

const BATCH_SIZE = 50; // one page of the active-jobs-with-no-analysis query at a time

function parseArgs() {
  const args = process.argv.slice(2);
  return { writeMode: args.includes("--write"), confirmed: args.includes("--confirm") };
}

async function fetchJobsNeedingAnalysis(supabase) {
  const jobs = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, title_original, description_text, company_name")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .is("ai_analysis", null)
      .order("id")
      .range(from, from + BATCH_SIZE - 1);
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    jobs.push(...data);
    if (data.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }
  return jobs;
}

async function runDryRun(supabase) {
  console.log("DRY RUN — no AI calls will be made, no database writes.\n");
  const jobs = await fetchJobsNeedingAnalysis(supabase);

  const byCompany = {};
  for (const j of jobs) byCompany[j.company_name] = (byCompany[j.company_name] || 0) + 1;

  console.log(`Found ${jobs.length} active, approved job(s) with no AI analysis at all.\n`);
  console.log("By company (top 15):");
  Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([company, count]) => console.log(`  ${company}: ${count}`));

  const reportPath = path.join(__dirname, `backfill-ai-analysis-dry-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    total: jobs.length,
    job_ids: jobs.map((j) => j.id),
  }, null, 2));
  console.log(`\nReport written to: ${reportPath}`);
  console.log("Re-run with: node backend/scripts/backfillMissingAiAnalysis.js --write --confirm");
}

async function runWrite(supabase) {
  console.log("WRITE MODE — will call analyzeJob() for every active job missing AI analysis.\n");
  const jobs = await fetchJobsNeedingAnalysis(supabase);
  console.log(`Processing ${jobs.length} job(s)...\n`);

  let analyzed = 0, closedNonSales = 0, failed = 0;
  const failures = [];

  for (const job of jobs) {
    try {
      const analysis = await analyzeJob(job.title_original, job.description_text);
      const hasSalesSignals = (
        (analysis?.product_categories?.length > 0) ||
        (analysis?.required_industries?.length > 0) ||
        (analysis?.sales_motion?.length > 0)
      );
      // Same rule ingest.js already applies to a freshly-analyzed job —
      // kept consistent rather than introducing a second standard.
      const statusUpdate = hasSalesSignals ? {} : { status: "closed" };
      if (!hasSalesSignals) closedNonSales++;

      const { error } = await supabase.from("jobs").update({ ai_analysis: analysis, ...statusUpdate }).eq("id", job.id);
      if (error) { failed++; failures.push({ id: job.id, error: error.message }); continue; }
      analyzed++;
      if (analyzed % 25 === 0) console.log(`  ...${analyzed}/${jobs.length} done`);
    } catch (err) {
      failed++;
      failures.push({ id: job.id, error: err.message });
      console.error(`  AI analysis failed for "${job.title_original}": ${err.message}`);
    }
  }

  console.log(`\nAnalyzed: ${analyzed}`);
  console.log(`Marked closed (no sales signals found): ${closedNonSales}`);
  console.log(`Failed (left for next run): ${failed}`);
  if (failures.length) {
    const resultsPath = path.join(__dirname, `backfill-ai-analysis-failures-${Date.now()}.json`);
    fs.writeFileSync(resultsPath, JSON.stringify(failures, null, 2));
    console.log(`Failure details written to: ${resultsPath}`);
  }
  console.log("\nSafe to re-run this script again later — it only ever picks up jobs still missing analysis.");
}

async function run() {
  const { writeMode, confirmed } = parseArgs();
  if (writeMode && !confirmed) {
    console.error("Refusing to run: --write requires --confirm too. No changes made.");
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (writeMode) return runWrite(supabase);
  return runDryRun(supabase);
}

run().catch((err) => {
  console.error("Backfill script crashed:", err);
  process.exit(1);
});
