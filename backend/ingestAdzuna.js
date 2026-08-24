// Adzuna ingestion — seeds real, currently-live job postings sourced
// from staffing/recruiting agencies into the "Recruiter Jobs" section,
// as a stand-in until real recruiters are posting directly through
// ROOK's own recruiter portal.
//
// IMPORTANT — this is explicitly NOT the same thing as a ROOK-native
// recruiter posting: there is no real recruiter_email / recruiter_name
// on file for these, so they're tagged source_type='agency_aggregated'
// (never 'recruiter_posted') and always link out to their real Adzuna
// posting to apply — never through ROOK's in-site Apply flow, which
// requires an actual recruiter contact to email. See adapters/adzuna.js.
//
// Every job saved here is a REAL, live listing pulled from Adzuna's own
// licensed API — nothing here is fabricated or synthetic. The
// agency-detection filter below is a best-effort heuristic (keyword
// match against company name / description), not a guarantee — it will
// occasionally miss a real agency listing or let through a borderline
// one, same limitation as the relevance filter used for ATS ingestion.
//
// Usage: node backend/ingestAdzuna.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { fetchAdzunaJobs, normalizeAdzunaJob } = require("./adapters/adzuna");
const { analyzeJob } = require("./ai/jobAnalysis");
const { generateEmbedding } = require("./ai/embeddings");
const { geocodeLocation } = require("./geocoding");
const { titleLooksRelevant } = require("./relevanceFilter");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Searched independently per keyword since Adzuna's "what" param is a
// single free-text query — covers the medical/veterinary sales space
// this platform is built for, same territory as the rest of ROOK.
const SEARCH_KEYWORDS = [
  "medical sales representative",
  "medical device sales",
  "pharmaceutical sales representative",
  "diagnostics sales",
  "veterinary sales representative",
  "clinical sales specialist",
  "capital equipment sales healthcare",
  "surgical sales representative",
  "orthopedic sales representative",
  "biotech sales representative",
  "healthcare account executive",
  "medical territory manager",
  "animal health sales",
  "hospital sales representative",
  "laboratory sales representative",
];

// Pages to pull per keyword. Adzuna returns 50 results/page; three
// pages per keyword (150 results) instead of one (50) meaningfully
// increases the pool the agency filter runs against — the filter
// itself was already conservative and working correctly (see prior run:
// 9/290 matched, no false positives found), the shortfall was in how
// much it had to search through, not the filter being too strict.
const PAGES_PER_KEYWORD = 3;

// Known staffing/recruiting agency names in the medical & veterinary
// sales space, plus generic staffing-firm words. A company name
// matching either counts as agency-sourced. This is a starting list,
// not exhaustive — real agency names not on it will be skipped rather
// than guessed at, which is the safer direction to err given the "never
// fabricate" requirement: missing a real agency listing is much better
// than mis-tagging a direct employer as an agency.
const KNOWN_AGENCY_NAMES = [
  "insight global", "culvercareers", "culver careers", "sales talent",
  "global edge recruiting", "medreps", "kforce", "adecco", "robert half",
  "aston carter", "randstad", "manpower", "professional medical",
  "medical sales college", "rxinsider", "iqvia talent", "pharmalink",
  "hireminds", "hirebridge", "clinical recruiter", "premier medical staffing",
  "rep-lite", "replite", "medzilla", "klein hersh", "divergx", "russell tobin",
  "medcareerfit", "intepros", "the medical sales rep", "med sales careers",
  "cannon medical staffing", "sales recruiters", "medsurg sales staffing",
  "blake smith staffing", "ciel healthcare", "healthcare businesswomen",
  "clinical staffing", "life sciences recruiting", "scientific search",
  "hunter recruiting", "mrinetwork", "mri network", "sanford rose",
  "lucas group", "beacon hill staffing", "kelly services", "vaco",
];
const AGENCY_KEYWORDS = [
  "recruiting", "recruiter", "recruitment", "staffing", "talent solutions",
  "executive search", "headhunt", "placement firm", "search firm", "personnel",
  "talent acquisition", "workforce solutions",
];

// Recruiting firms very often post on behalf of an undisclosed employer
// — the company_name field is blank, generic ("Confidential"), or is
// the RECRUITING FIRM's own name, but the actual "this is a third-party
// search" signal only shows up in the posting's own text ("our client
// is seeking...", "on behalf of our client", "we've been retained to
// find..."). Checking description text alongside company name catches
// these — the same MedReps-style listing pattern seen earlier in this
// project (the QIAGEN/Boston listing: "Our Client is a well established,
// fast growing medical device company... They've asked us to help them
// find a Region Sales Manager").
const AGENCY_DESCRIPTION_PHRASES = [
  "our client is", "on behalf of our client", "our client, a", "confidential search",
  "we have been retained", "we've been retained", "retained search",
  "our client is seeking", "they've asked us to help", "staffing agency",
  "leading staffing", "recruiting firm", "search firm",
];

function looksLikeAgency(companyName, descriptionText) {
  const lowerCompany = (companyName || "").toLowerCase();
  const lowerDesc = (descriptionText || "").toLowerCase();
  if (KNOWN_AGENCY_NAMES.some((n) => lowerCompany.includes(n))) return true;
  if (AGENCY_KEYWORDS.some((k) => lowerCompany.includes(k))) return true;
  if (AGENCY_DESCRIPTION_PHRASES.some((p) => lowerDesc.includes(p))) return true;
  return false;
}

async function run() {
  let totalFetched = 0;
  let totalAgencyMatched = 0;
  let totalSaved = 0;
  let aiAnalyzedThisRun = 0;
  const AI_ANALYSIS_CAP_THIS_RUN = 60;

  for (const keyword of SEARCH_KEYWORDS) {
    console.log(`\nSearching Adzuna for "${keyword}"...`);
    let rawJobs = [];
    for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
      try {
        const pageResults = await fetchAdzunaJobs(keyword, page, 50);
        if (pageResults.length === 0) break; // no more pages for this keyword
        rawJobs.push(...pageResults);
      } catch (err) {
        console.error(`  FAILED on page ${page}: ${err.message}`);
        break;
      }
    }
    totalFetched += rawJobs.length;
    console.log(`  ${rawJobs.length} result(s) returned across up to ${PAGES_PER_KEYWORD} page(s).`);

    for (const raw of rawJobs) {
      const companyName = raw.company?.display_name || "";
      if (!looksLikeAgency(companyName, raw.description)) continue; // direct employer, not an agency — skip, this pass is agency-only by design
      totalAgencyMatched++;

      const job = normalizeAdzunaJob(raw);
      if (!titleLooksRelevant(job.title_original)) continue;

      // Manual check-then-write rather than .upsert()+onConflict: the
      // dedup index on source_job_id is a PARTIAL index (only applies
      // where source_type='agency_aggregated'), and Postgres won't use a
      // partial index as an ON CONFLICT arbiter unless the conflict
      // clause repeats that exact WHERE condition — which supabase-js's
      // upsert() doesn't support specifying. This avoids that limitation
      // entirely instead of fighting it.
      const { data: existing } = await supabase
        .from("jobs")
        .select("id, ai_analysis, job_embedding, job_lat, location_raw")
        .eq("source_type", "agency_aggregated")
        .eq("source_job_id", job.source_job_id)
        .maybeSingle();

      let upsertedRow;
      let error;
      if (existing) {
        ({ data: upsertedRow, error } = await supabase
          .from("jobs")
          .update({ ...job, last_seen_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select()
          .single());
      } else {
        ({ data: upsertedRow, error } = await supabase
          .from("jobs")
          .insert({ ...job, last_seen_at: new Date().toISOString() })
          .select()
          .single());
      }

      if (error) {
        console.error(`  Save error for "${job.title_original}" (${companyName}): ${error.message}`);
        continue;
      }
      totalSaved++;
      console.log(`  Saved: "${job.title_original}" — ${companyName}`);

      if (aiAnalyzedThisRun < AI_ANALYSIS_CAP_THIS_RUN && !upsertedRow.ai_analysis) {
        aiAnalyzedThisRun++;
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

      if (upsertedRow.job_lat == null && upsertedRow.location_raw) {
        try {
          const coords = await geocodeLocation(upsertedRow.location_raw);
          if (coords) {
            await supabase.from("jobs").update({ job_lat: coords.lat, job_lng: coords.lng }).eq("id", upsertedRow.id);
          }
        } catch (err) {
          console.error(`  Geocoding failed for "${job.location_raw}": ${err.message}`);
        }
      }
    }
  }

  console.log(
    `\nDone. ${totalFetched} total result(s) examined, ${totalAgencyMatched} matched the agency filter, ${totalSaved} saved/updated.`
  );
}

run();
