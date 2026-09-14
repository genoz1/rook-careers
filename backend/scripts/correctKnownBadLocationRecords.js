#!/usr/bin/env node
// backend/scripts/correctKnownBadLocationRecords.js
//
// Corrects the 13 exact job records confirmed, by direct investigation
// (not inference), to have wrong stored coordinates:
//   - 10 records where a bare/near-bare foreign country name (Tanzania,
//     Kuwait, Zimbabwe, Cameroon, Senegal, Kazakhstan, Zambia x2,
//     Mozambique, "Panama, Panamá, Panama") matched an embassy or a
//     coincidentally-named US place via Nominatim.
//   - 2 records confirmed to be genuinely Barcelona, SPAIN (Sanofi
//     postings, source URL and description both explicit) that
//     happened to match "Barcelona", a hamlet in Chautauqua County, NY.
//   - 1 record ("Remote, NH | Nashua, New Hampshire", a real MWI Animal
//     Health / Cencora New Hampshire job) whose stored coordinate does
//     not correspond to Nashua at all — a pre-existing multi-location
//     parsing defect, not a foreign-country match, but equally wrong.
//
// All 13 currently have job_lat, job_lng set to the wrong values below,
// and `state` already null (confirmed directly against the live
// database before this script was written — state has been null for
// every job in the database, this fix included). Correction: set
// job_lat, job_lng, AND state to NULL for exactly these 13 IDs — no
// other rows are touched.
//
// DRY RUN BY DEFAULT. Requires BOTH --write AND --confirm to write
// anything.
//
// Run (dry-run, safe, default):
//   node backend/scripts/correctKnownBadLocationRecords.js
//
// Run (write phase — NOT to be run without separate, explicit approval):
//   node backend/scripts/correctKnownBadLocationRecords.js --write --confirm
//
// Run (rollback — restores the exact original values listed below):
//   node backend/scripts/correctKnownBadLocationRecords.js --rollback --confirm

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// The exact 13 records, their exact original (wrong) values, and why.
// Rollback restores from this literal list — no separate report file
// is needed for rollback here, since every original value is already
// fully known and embedded directly in this script for review.
const RECORDS = [
  { id: "db7e9d00-c286-4c8e-8c67-f971fe250816", original_lat: "38.9061022", original_lng: "-77.0491254", original_state: null, reason: "location_raw \"Tanzania\" matched the Embassy of Tanzania in Washington, DC" },
  { id: "baef5492-73a8-4237-9499-e7de74b5cdb2", original_lat: "38.9405905", original_lng: "-77.0591931", original_state: null, reason: "location_raw \"Kuwait\" matched the Embassy of Kuwait in Washington, DC" },
  { id: "7691e1b6-8392-45d7-a257-0c92671b2029", original_lat: "38.9115684", original_lng: "-77.0420881", original_state: null, reason: "location_raw \"Zimbabwe\" matched the Embassy of Zimbabwe in Washington, DC" },
  { id: "0a15a7eb-779c-49d5-b6ba-b50e91d06d31", original_lat: "38.9137609", original_lng: "-77.0523275", original_state: null, reason: "location_raw \"Cameroon\" matched the Embassy of Cameroon in Washington, DC" },
  { id: "8040b507-339b-46ab-98e7-8fda125f7d60", original_lat: "38.9054635", original_lng: "-77.0494661", original_state: null, reason: "location_raw \"Senegal\" matched the Embassy of Senegal in Washington, DC" },
  { id: "5c051ab3-8e40-4042-820a-bc25d1126b5d", original_lat: "38.9088785", original_lng: "-77.0361167", original_state: null, reason: "location_raw \"Kazakhstan\" matched the Embassy of Kazakhstan in Washington, DC" },
  { id: "8d14b1ee-b382-48e4-a531-36c91449276b", original_lat: "32.0706718", original_lng: "-84.2415783", original_state: null, reason: "location_raw \"Zambia\" matched a building named \"Zambia\" in Americus, GA (1 of 2 records)" },
  { id: "37c5dda7-add8-4754-8f39-40d057da59e5", original_lat: "32.0706718", original_lng: "-84.2415783", original_state: null, reason: "location_raw \"Zambia\" matched a building named \"Zambia\" in Americus, GA (2 of 2 records)" },
  { id: "b21c7ed2-9749-4d43-ad67-66d304cf18b0", original_lat: "18.4071609", original_lng: "-66.0932534", original_state: null, reason: "location_raw \"Mozambique\" matched a footpath named \"Mozambique\" in San Juan, Puerto Rico" },
  { id: "519cb3e1-1b7d-40dd-9a38-450ae5971980", original_lat: "42.0740813", original_lng: "-79.4924188", original_state: null, reason: "location_raw \"Panama, Panamá, Panama\" matched Panama Dam in Panama, NY" },
  { id: "226f8b0f-6577-478c-9c50-e369e8cf18c6", original_lat: "42.3403356", original_lng: "-79.5958808", original_state: null, reason: "confirmed genuinely Barcelona, SPAIN (Sanofi Sales Representative; source URL and Spanish-language description both explicit) — location_raw \"Barcelona\" matched Barcelona, NY instead" },
  { id: "93402f62-4c5d-456e-af08-c11132958f1b", original_lat: "42.3403356", original_lng: "-79.5958808", original_state: null, reason: "confirmed genuinely Barcelona, SPAIN (Sanofi Project Manager Medical Communications; description explicitly states \"Location: Barcelona, Spain\") — location_raw \"Barcelona\" matched Barcelona, NY instead" },
  { id: "9e4116c4-a3c8-448b-b733-d3468b92f9f9", original_lat: "45.2838212", original_lng: "-71.1020442", original_state: null, reason: "real New Hampshire job (MWI Animal Health / Cencora, title and location_raw both explicit) but stored coordinate does not correspond to Nashua, NH at all — a pre-existing multi-location parsing defect" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return { writeMode: args.includes("--write"), rollbackMode: args.includes("--rollback"), confirmed: args.includes("--confirm") };
}

async function runDryRun(supabase) {
  console.log("DRY RUN — no database writes will be made.\n");
  const report = [];
  for (const record of RECORDS) {
    const { data: current, error } = await supabase
      .from("jobs")
      .select("id, title_original, location_raw, job_lat, job_lng, state")
      .eq("id", record.id)
      .maybeSingle();
    if (error) { report.push({ id: record.id, status: "ERROR", detail: error.message }); continue; }
    if (!current) { report.push({ id: record.id, status: "NOT FOUND" }); continue; }

    const matchesExpected =
      String(current.job_lat) === record.original_lat &&
      String(current.job_lng) === record.original_lng &&
      (current.state || null) === record.original_state;

    report.push({
      id: record.id,
      title: current.title_original,
      location_raw: current.location_raw,
      current_job_lat: current.job_lat,
      current_job_lng: current.job_lng,
      current_state: current.state,
      matches_expected_original_values: matchesExpected,
      would_set: { job_lat: null, job_lng: null, state: null },
      reason: record.reason,
    });
  }

  const reportPath = path.join(__dirname, `correct-known-bad-dry-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: "dry-run", entries: report }, null, 2));
  console.log(`Checked ${report.length} record(s). Report written to: ${reportPath}`);
  const mismatches = report.filter((r) => r.matches_expected_original_values === false);
  if (mismatches.length) {
    console.log(`\nWARNING: ${mismatches.length} record(s) no longer match the expected original values recorded in this script — review before writing:`);
    console.log(JSON.stringify(mismatches, null, 2));
  }
}

async function runWrite(supabase) {
  console.log("WRITE MODE — this WILL update 13 specific rows.\n");
  const results = { successful: [], skipped: [], failed: [] };
  for (const record of RECORDS) {
    const { data: current, error: fetchErr } = await supabase
      .from("jobs")
      .select("id, job_lat, job_lng, state")
      .eq("id", record.id)
      .maybeSingle();
    if (fetchErr) { results.failed.push({ id: record.id, error: fetchErr.message }); continue; }
    if (!current) { results.skipped.push({ id: record.id, reason: "row no longer exists" }); continue; }

    const matchesExpected =
      String(current.job_lat) === record.original_lat &&
      String(current.job_lng) === record.original_lng &&
      (current.state || null) === record.original_state;
    if (!matchesExpected) {
      results.skipped.push({ id: record.id, reason: "current values no longer match the expected original — not overwriting" });
      continue;
    }

    const { error: updateErr } = await supabase.from("jobs").update({ job_lat: null, job_lng: null, state: null }).eq("id", record.id);
    if (updateErr) { results.failed.push({ id: record.id, error: updateErr.message }); continue; }
    results.successful.push(record.id);
  }
  const resultsPath = path.join(__dirname, `correct-known-bad-write-results-${Date.now()}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: "write", ...results }, null, 2));
  console.log(`Successful: ${results.successful.length} | Skipped: ${results.skipped.length} | Failed: ${results.failed.length}`);
  console.log(`Results written to: ${resultsPath}`);
}

async function runRollback(supabase) {
  console.log("ROLLBACK MODE — restoring the exact original (wrong) values listed in this script.\n");
  const results = { restored: [], skipped: [], failed: [] };
  for (const record of RECORDS) {
    const { data: current, error: fetchErr } = await supabase
      .from("jobs")
      .select("id, job_lat, job_lng, state")
      .eq("id", record.id)
      .maybeSingle();
    if (fetchErr) { results.failed.push({ id: record.id, error: fetchErr.message }); continue; }
    if (!current) { results.skipped.push({ id: record.id, reason: "row no longer exists" }); continue; }
    // Only restore if the row is currently null/null/null, i.e. still
    // exactly in the state this script's write phase would have left
    // it in — never overwrite a row that's since been legitimately
    // re-ingested with new, different values.
    if (current.job_lat !== null || current.job_lng !== null || current.state !== null) {
      results.skipped.push({ id: record.id, reason: "row is not currently null/null/null — has changed since the correction, not restoring" });
      continue;
    }
    const { error: updateErr } = await supabase.from("jobs").update({ job_lat: record.original_lat, job_lng: record.original_lng, state: record.original_state }).eq("id", record.id);
    if (updateErr) { results.failed.push({ id: record.id, error: updateErr.message }); continue; }
    results.restored.push(record.id);
  }
  console.log(`Restored: ${results.restored.length} | Skipped: ${results.skipped.length} | Failed: ${results.failed.length}`);
  if (results.skipped.length) console.log("Skipped:", JSON.stringify(results.skipped, null, 2));
}

async function run() {
  const { writeMode, rollbackMode, confirmed } = parseArgs();
  if ((writeMode || rollbackMode) && !confirmed) {
    console.error("Refusing to run: --write or --rollback was passed without --confirm. No changes made.");
    process.exit(1);
  }
  if (writeMode && rollbackMode) {
    console.error("Refusing to run: --write and --rollback cannot both be passed. No changes made.");
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (rollbackMode) return runRollback(supabase);
  if (writeMode) return runWrite(supabase);
  return runDryRun(supabase);
}

run().catch((err) => {
  console.error("Correction script crashed:", err);
  process.exit(1);
});
