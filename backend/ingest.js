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
const { fetchWorkdayJobs, normalizeWorkdayJob } = require("./adapters/workday");
const { fetchTalentBrewJobs, normalizeTalentBrewJob } = require("./adapters/talentbrew");
const { analyzeJob } = require("./ai/jobAnalysis");
const { generateEmbedding } = require("./ai/embeddings");

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

    // AI job analysis + embedding both run once per job, ever — not on
    // every re-ingestion run. This keeps API cost bounded: a job already
    // analyzed on a previous run is skipped even if it's seen again
    // today. A failure here doesn't affect the job being saved — it
    // just means that job scores without the AI-derived factors until a
    // later run retries it.
    if (!upsertedRow.ai_analysis) {
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
    `  Done — ${savedCount} relevant job(s) saved (${rawJobs.length} total posting(s) examined), ${closedIds.length} closed.`
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
const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical",
];
function looksRelevant(title = "") {
  const t = title.toLowerCase();
  if (STRONG_TITLE_SIGNALS.some((k) => t.includes(k))) return true;
  const hasRoleWord = ROLE_WORDS.some((k) => t.includes(k));
  const hasDomainWord = DOMAIN_WORDS.some((k) => t.includes(k));
  return hasRoleWord && hasDomainWord;
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
