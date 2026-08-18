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
const { fetchGreenhouseJobs, normalizeGreenhouseJob } = require("./adapters/greenhouse");
const { fetchLeverJobs, normalizeLeverJob } = require("./adapters/lever");
const { fetchAshbyJobs, normalizeAshbyJob } = require("./adapters/ashby");

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

  for (const raw of rawJobs) {
    const job = normalize(raw, employer);
    seenSourceIds.add(job.source_job_id);

    // Relevance filter: a very rough first pass. Replace with real
    // classification once the normalization step (Phase 1.5) is built —
    // for now this just keeps obviously-unrelated roles out.
    if (!looksRelevant(job.title_original)) continue;

    const { error } = await supabase
      .from("jobs")
      .upsert(
        { ...job, last_seen_at: new Date().toISOString() },
        { onConflict: "employer_id,source_job_id" }
      );
    if (error) console.error(`  Upsert error for "${job.title_original}": ${error.message}`);
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

  console.log(`  Done — ${rawJobs.length} jobs seen, ${closedIds.length} closed.`);
}

// Extremely rough placeholder relevance filter — a real version should
// use the ROOK role-family classification from the architecture spec
// (section 18), likely with AI assistance for ambiguous titles.
const RELEVANT_KEYWORDS = [
  "sales", "account executive", "territory", "representative", "specialist",
  "business development", "key account", "regional manager", "clinical",
];
function looksRelevant(title = "") {
  const t = title.toLowerCase();
  return RELEVANT_KEYWORDS.some((k) => t.includes(k));
}

async function run() {
  const { data: employers, error } = await supabase
    .from("employers")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Could not load employers:", error.message);
    process.exit(1);
  }

  console.log(`Found ${employers.length} active employer(s) to sync.\n`);

  for (const employer of employers) {
    await ingestEmployer(employer);
  }

  console.log("\nIngestion run complete.");
}

run();
