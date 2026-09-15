#!/usr/bin/env node
// backend/scripts/correctKnownBadLocationRecords.js
//
// Corrects the 13 exact job records confirmed, by direct investigation
// (title, company, source URL, description — never inferred from the
// coordinate), to have wrong stored coordinates:
//   - 10 records where a bare/near-bare foreign country name matched an
//     embassy or a coincidentally-named US place via Nominatim.
//   - 2 records confirmed genuinely Barcelona, SPAIN (Sanofi postings)
//     that coincidentally matched Barcelona, NY.
//   - 1 record ("Remote, NH | Nashua, New Hampshire", a real MWI Animal
//     Health / Cencora job) whose stored coordinate does not correspond
//     to Nashua at all.
//
// All 13 currently have job_lat/job_lng set to the wrong values below
// and `state` already null. Correction: set job_lat, job_lng, AND state
// to NULL for exactly these 13 IDs.
//
// THREE MODES, same pattern as backfillJobStates.js:
//
//   1. DRY RUN (default) — checks each record against its expected
//      original values, zero writes, produces a report.
//
//   2. WRITE (`--write --confirm`) — for each of the 13, a single
//      atomic conditional UPDATE requires job_lat/job_lng/state to
//      still equal the expected original values before nulling them;
//      confirmed from the returned row, not a separate read-then-write.
//      Produces a write-results report containing the exact successful
//      IDs AND their original values (self-sufficient for rollback —
//      no need to trust this script's hardcoded list again later).
//
//   3. ROLLBACK (`--rollback --confirm --report=<path-to-a-write-results-report>`)
//      REQUIRES that specific write-results report. Restores only the
//      records that report documents as successfully changed BY THAT
//      OPERATION — never the full hardcoded list, and never merely
//      because a row currently contains nulls (a freshly re-ingested
//      row could be null/null/null for an unrelated reason). Each
//      restore is an atomic conditional UPDATE requiring the row to
//      currently be exactly null/null/null before restoring.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

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
  { id: "9e4116c4-a3c8-448b-b733-d3468b92f9f9", original_lat: "45.2838212", original_lng: "-71.1020442", original_state: null, reason: "real New Hampshire job (MWI Animal Health / Cencora) but stored coordinate does not correspond to Nashua, NH at all" },
];

function guardedUpdate(supabase, { id, expectedLat, expectedLng, expectedState, newValues }) {
  let query = supabase.from("jobs").update(newValues).eq("id", id);
  query = (expectedLat === null || expectedLat === undefined) ? query.is("job_lat", null) : query.eq("job_lat", expectedLat);
  query = (expectedLng === null || expectedLng === undefined) ? query.is("job_lng", null) : query.eq("job_lng", expectedLng);
  query = (expectedState === null || expectedState === undefined) ? query.is("state", null) : query.eq("state", expectedState);
  return query.select();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const reportArg = args.find((a) => a.startsWith("--report="));
  return {
    writeMode: args.includes("--write"),
    rollbackMode: args.includes("--rollback"),
    confirmed: args.includes("--confirm"),
    reportPath: reportArg ? reportArg.slice("--report=".length) : null,
  };
}

async function runDryRun(supabase) {
  console.log("DRY RUN — no database writes will be made.\n");
  const entries = [];
  for (const record of RECORDS) {
    const { data: current, error } = await supabase
      .from("jobs")
      .select("id, title_original, location_raw, job_lat, job_lng, state")
      .eq("id", record.id)
      .maybeSingle();
    if (error) { entries.push({ id: record.id, status: "ERROR", detail: error.message }); continue; }
    if (!current) { entries.push({ id: record.id, status: "NOT FOUND" }); continue; }

    const matchesExpected =
      String(current.job_lat) === record.original_lat &&
      String(current.job_lng) === record.original_lng &&
      (current.state || null) === record.original_state;

    entries.push({
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
  fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: "dry-run", entries }, null, 2));
  console.log(`Checked ${entries.length} record(s). Report written to: ${reportPath}`);
  const mismatches = entries.filter((r) => r.matches_expected_original_values === false);
  if (mismatches.length) {
    console.log(`\nWARNING: ${mismatches.length} record(s) no longer match the expected original values — review before writing:`);
    console.log(JSON.stringify(mismatches, null, 2));
  }
}

async function runWrite(supabase) {
  console.log("WRITE MODE — this WILL update up to 13 specific rows, each via a single atomic conditional UPDATE.\n");
  const successful = [];
  const skipped = [];
  const failed = [];

  for (const record of RECORDS) {
    try {
      const { data, error } = await guardedUpdate(supabase, {
        id: record.id,
        expectedLat: record.original_lat,
        expectedLng: record.original_lng,
        expectedState: record.original_state,
        newValues: { job_lat: null, job_lng: null, state: null },
      });
      if (error) { failed.push({ id: record.id, error: error.message }); continue; }
      if (!data || data.length === 0) {
        skipped.push({ id: record.id, reason: "guarded update matched zero rows — current values no longer equal the expected original" });
        continue;
      }
      // Record the exact original values alongside the ID — the
      // write-results report must be self-sufficient for rollback,
      // not dependent on trusting this script's hardcoded list again.
      successful.push({
        id: record.id,
        original_job_lat: record.original_lat,
        original_job_lng: record.original_lng,
        original_state: record.original_state,
      });
    } catch (err) {
      failed.push({ id: record.id, error: err.message });
    }
  }

  const resultsPath = path.join(__dirname, `correct-known-bad-write-results-${Date.now()}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: "write", successful, skipped, failed }, null, 2));
  console.log(`Successful: ${successful.length} | Skipped: ${skipped.length} | Failed: ${failed.length}`);
  console.log(`Results written to: ${resultsPath}`);
  console.log("Keep this file — it's required to roll back. Rollback command:");
  console.log(`  node backend/scripts/correctKnownBadLocationRecords.js --rollback --confirm --report=${resultsPath}`);
}

async function runRollback(supabase, reportPath) {
  if (!reportPath) {
    console.error("--rollback requires --report=<path-to-a-write-results-report.json>. No changes made.");
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`Report file not found: ${reportPath}. No changes made.`);
    process.exit(1);
  }
  const writeReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (writeReport.mode !== "write") {
    console.error(`Refusing to proceed: expected a write-results report (mode "write"), got ${JSON.stringify(writeReport.mode)}.`);
    process.exit(1);
  }
  const toRestore = writeReport.successful || [];
  console.log(`ROLLBACK MODE — restoring exactly the ${toRestore.length} record(s) ${reportPath} documented as successfully changed.\n`);

  const restored = [];
  const skipped = [];
  const failed = [];

  for (const entry of toRestore) {
    try {
      // Atomic conditional update: only restores if the row is
      // currently EXACTLY null/null/null (what this script's write
      // phase would have left it in) — never merely because it
      // contains nulls for some unrelated reason.
      const { data, error } = await guardedUpdate(supabase, {
        id: entry.id,
        expectedLat: null,
        expectedLng: null,
        expectedState: null,
        newValues: { job_lat: entry.original_job_lat, job_lng: entry.original_job_lng, state: entry.original_state },
      });
      if (error) { failed.push({ id: entry.id, error: error.message }); continue; }
      if (!data || data.length === 0) {
        skipped.push({ id: entry.id, reason: "guarded update matched zero rows — row is not currently null/null/null" });
        continue;
      }
      restored.push(entry.id);
    } catch (err) {
      failed.push({ id: entry.id, error: err.message });
    }
  }

  console.log(`Restored: ${restored.length} | Skipped: ${skipped.length} | Failed: ${failed.length}`);
  if (skipped.length) console.log("Skipped:", JSON.stringify(skipped, null, 2));
  if (failed.length) console.log("Failed:", JSON.stringify(failed, null, 2));
}

async function run() {
  const { writeMode, rollbackMode, confirmed, reportPath } = parseArgs();
  if ((writeMode || rollbackMode) && !confirmed) {
    console.error("Refusing to run: --write or --rollback was passed without --confirm. No changes made.");
    process.exit(1);
  }
  if (writeMode && rollbackMode) {
    console.error("Refusing to run: --write and --rollback cannot both be passed. No changes made.");
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (rollbackMode) return runRollback(supabase, reportPath);
  if (writeMode) return runWrite(supabase);
  return runDryRun(supabase);
}

run().catch((err) => {
  console.error("Correction script crashed:", err);
  process.exit(1);
});
