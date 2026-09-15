#!/usr/bin/env node
// backend/scripts/backfillJobStates.js
//
// One-time backfill: for every active, approved job that already has
// real job_lat/job_lng but a null `state`, resolve the real US
// state/DC/territory that coordinate falls inside, using a LOCAL,
// OFFLINE point-in-polygon check against the U.S. Census Bureau's real
// boundary data (us-atlas + topojson-client + @turf/boolean-point-in-
// polygon) — not a new Nominatim call.
//
// THREE MODES:
//
//   1. DRY RUN (default) — recomputes fresh, zero writes, produces a
//      timestamped report file.
//
//   2. WRITE (`--write --confirm --report=<path-to-a-dry-run-report>`)
//      Validates the report file first (see backfillReportValidation.js
//      — must be mode "dry-run", well-formed, unique job IDs, valid
//      state/FIPS pairs) and refuses to proceed if invalid. Does NOT
//      recompute anything from the live database — applies only what's
//      in the validated report. Each write is a SINGLE atomic
//      conditional UPDATE (`WHERE id = ? AND job_lat = ? AND job_lng =
//      ? AND state IS/= ?`), so the check-and-write is one database
//      operation, not a separate read then a separate write with a race
//      window in between. Whether the update actually matched a row is
//      confirmed directly from Postgres's returned row count (via
//      .select() after .update()) — zero rows back means the row had
//      already changed since the dry run, and it's recorded as
//      skipped, not silently treated as a no-op success.
//
//   3. ROLLBACK (`--rollback --confirm --report=<path-to-a-write-results-report>`)
//      Same atomic-conditional-update approach: clears `state` back to
//      NULL only via an UPDATE whose WHERE clause requires state AND
//      coordinates to still equal exactly what mode 2 wrote — confirmed
//      from the returned row, not a separate check.
//
// Every mode besides plain dry-run requires BOTH a mode flag (--write
// or --rollback) AND --confirm.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const topojson = require("topojson-client");
const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default;
const usAtlas = require("us-atlas/states-10m.json");
const { validateDryRunReport, FIPS_TO_ABBR } = require("../backfillReportValidation");

// Exact IDs confirmed and listed during this project's assessment —
// must never receive a backfilled state under any mode.
const KNOWN_BAD_RECORD_IDS = [
  "db7e9d00-c286-4c8e-8c67-f971fe250816", // Tanzania
  "baef5492-73a8-4237-9499-e7de74b5cdb2", // Kuwait
  "7691e1b6-8392-45d7-a257-0c92671b2029", // Zimbabwe
  "0a15a7eb-779c-49d5-b6ba-b50e91d06d31", // Cameroon
  "8040b507-339b-46ab-98e7-8fda125f7d60", // Senegal
  "5c051ab3-8e40-4042-820a-bc25d1126b5d", // Kazakhstan
  "8d14b1ee-b382-48e4-a531-36c91449276b", // Zambia (1 of 2)
  "37c5dda7-add8-4754-8f39-40d057da59e5", // Zambia (2 of 2)
  "b21c7ed2-9749-4d43-ad67-66d304cf18b0", // Mozambique
  "519cb3e1-1b7d-40dd-9a38-450ae5971980", // Panama, Panamá, Panama
  "226f8b0f-6577-478c-9c50-e369e8cf18c6", // Barcelona, Spain (Sanofi Sales Representative)
  "93402f62-4c5d-456e-af08-c11132958f1b", // Barcelona, Spain (Sanofi Project Manager Medical Communications)
  "9e4116c4-a3c8-448b-b733-d3468b92f9f9", // "Remote, NH | Nashua, New Hampshire"
];

function buildStatePolygons() {
  const geo = topojson.feature(usAtlas, usAtlas.objects.states);
  return geo.features.map((f) => ({ id: f.id, abbr: FIPS_TO_ABBR[f.id] || null, geometry: f }));
}

function findStateForPoint(lat, lng, statePolygons) {
  const point = { type: "Point", coordinates: [lng, lat] };
  for (const state of statePolygons) {
    if (!state.abbr) continue;
    try {
      if (booleanPointInPolygon(point, state.geometry)) return state;
    } catch (_) {}
  }
  return null;
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

// Builds a single, atomic, conditional UPDATE — the WHERE clause
// itself encodes the "still matches what was reviewed" guard, so the
// check and the write are one database round trip, not two. .select()
// after .update() makes Postgres return the row(s) actually changed;
// an empty result means the guard didn't match anything (the row had
// already moved on), which the caller treats as "skipped", never as a
// silent success.
function guardedUpdate(supabase, { id, expectedLat, expectedLng, expectedState, newValues }) {
  let query = supabase.from("jobs").update(newValues).eq("id", id);
  query = (expectedLat === null || expectedLat === undefined) ? query.is("job_lat", null) : query.eq("job_lat", expectedLat);
  query = (expectedLng === null || expectedLng === undefined) ? query.is("job_lng", null) : query.eq("job_lng", expectedLng);
  query = (expectedState === null || expectedState === undefined) ? query.is("state", null) : query.eq("state", expectedState);
  return query.select();
}

async function runDryRun(supabase) {
  console.log("DRY RUN — recomputing fresh from the live database. No writes will be made.\n");

  const statePolygons = buildStatePolygons();
  console.log(`Loaded ${statePolygons.length} US state/DC/territory boundary polygons (offline, no network calls).\n`);

  const allRows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, location_raw, job_lat, job_lng, state")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .not("job_lat", "is", null)
      .not("job_lng", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const rows = allRows.filter((r) => !KNOWN_BAD_RECORD_IDS.includes(r.id));
  console.log(`Fetched ${allRows.length} rows with coordinates; excluded ${allRows.length - rows.length} known-bad record(s); processing ${rows.length}.\n`);

  const entries = [];
  let matched = 0, unmatched = 0, alreadyHadState = 0;

  for (const row of rows) {
    if (row.state) { alreadyHadState++; continue; }
    const lat = parseFloat(row.job_lat);
    const lng = parseFloat(row.job_lng);
    const match = findStateForPoint(lat, lng, statePolygons);
    entries.push({
      job_id: row.id,
      location_raw: row.location_raw,
      current_job_lat: row.job_lat,
      current_job_lng: row.job_lng,
      current_state: row.state,
      proposed_state: match ? match.abbr : null,
      matched_fips: match ? match.id : null,
      reason: match
        ? `point (${lat}, ${lng}) falls inside the ${match.abbr} (FIPS ${match.id}) polygon`
        : "point did not fall inside any US state/DC/territory polygon — needs manual review",
    });
    if (match) matched++; else unmatched++;
  }

  const reportPath = path.join(__dirname, `backfill-dry-run-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    total_rows_with_coordinates: allRows.length,
    excluded_known_bad_records: allRows.length - rows.length,
    already_had_state_skipped: alreadyHadState,
    matched, unmatched,
    entries,
  }, null, 2));

  console.log(`Matched:   ${matched}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Already had a state (skipped): ${alreadyHadState}`);
  console.log(`\nReport written to: ${reportPath}`);
  console.log("\nDry run complete. No database rows were changed. Review the report, then re-run with:");
  console.log(`  node backend/scripts/backfillJobStates.js --write --confirm --report=${reportPath}`);
}

async function runWrite(supabase, reportPath) {
  if (!reportPath) {
    console.error("--write requires --report=<path-to-a-dry-run-report.json>. No changes made.");
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`Report file not found: ${reportPath}. No changes made.`);
    process.exit(1);
  }

  const sourceReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const validation = validateDryRunReport(sourceReport);
  if (!validation.valid) {
    console.error("Refusing to proceed: the report failed validation.");
    console.error(JSON.stringify(validation.errors, null, 2));
    process.exit(1);
  }
  console.log(`Report validated OK (mode="dry-run", ${sourceReport.entries.length} entries, no duplicate IDs, all proposed states valid and FIPS-consistent).\n`);

  console.log(`WRITE MODE — applying EXACTLY what's in ${reportPath}. Not recomputing anything.\n`);
  const candidates = sourceReport.entries.filter((e) => e.proposed_state && !KNOWN_BAD_RECORD_IDS.includes(e.job_id));
  console.log(`${candidates.length} row(s) in the report have a proposed_state and aren't a known-bad record.\n`);

  const successful = [];
  const skipped = [];
  const failed = [];

  for (const entry of candidates) {
    try {
      const { data, error } = await guardedUpdate(supabase, {
        id: entry.job_id,
        expectedLat: entry.current_job_lat,
        expectedLng: entry.current_job_lng,
        expectedState: entry.current_state,
        newValues: { state: entry.proposed_state },
      });
      if (error) { failed.push({ job_id: entry.job_id, error: error.message }); continue; }
      if (!data || data.length === 0) {
        skipped.push({ job_id: entry.job_id, reason: "guarded update matched zero rows — row's current job_lat/job_lng/state no longer equal the reviewed dry-run values" });
        continue;
      }
      successful.push({
        job_id: entry.job_id,
        written_state: entry.proposed_state,
        original_job_lat: entry.current_job_lat,
        original_job_lng: entry.current_job_lng,
      });
    } catch (err) {
      failed.push({ job_id: entry.job_id, error: err.message });
    }
  }

  const writeResultsPath = path.join(__dirname, `backfill-write-results-${Date.now()}.json`);
  fs.writeFileSync(writeResultsPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: "write",
    source_report: reportPath,
    successful, skipped, failed,
  }, null, 2));

  console.log(`Successful: ${successful.length}`);
  console.log(`Skipped:    ${skipped.length}`);
  console.log(`Failed:     ${failed.length}`);
  console.log(`\nWrite-results report written to: ${writeResultsPath}`);
  console.log("Keep this file — it's required to roll back. Rollback command:");
  console.log(`  node backend/scripts/backfillJobStates.js --rollback --confirm --report=${writeResultsPath}`);
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
  const toRollBack = writeReport.successful || [];
  console.log(`ROLLBACK MODE — reverting exactly the ${toRollBack.length} row(s) ${reportPath} recorded as successful.\n`);

  const rolledBack = [];
  const skipped = [];
  const failed = [];

  for (const entry of toRollBack) {
    try {
      // Atomic conditional update: only clears state if it STILL equals
      // exactly what this backfill wrote, at the ORIGINAL coordinates
      // recorded at write time — never based merely on the row
      // currently containing nulls (a freshly re-ingested row could be
      // null/null/null for a completely unrelated reason).
      const { data, error } = await guardedUpdate(supabase, {
        id: entry.job_id,
        expectedLat: entry.original_job_lat,
        expectedLng: entry.original_job_lng,
        expectedState: entry.written_state,
        newValues: { state: null },
      });
      if (error) { failed.push({ job_id: entry.job_id, error: error.message }); continue; }
      if (!data || data.length === 0) {
        skipped.push({ job_id: entry.job_id, reason: "guarded update matched zero rows — row no longer matches what this backfill wrote" });
        continue;
      }
      rolledBack.push(entry.job_id);
    } catch (err) {
      failed.push({ job_id: entry.job_id, error: err.message });
    }
  }

  console.log(`Rolled back: ${rolledBack.length}`);
  console.log(`Skipped:     ${skipped.length}`);
  console.log(`Failed:      ${failed.length}`);
  if (skipped.length) console.log("\nSkipped entries:", JSON.stringify(skipped, null, 2));
  if (failed.length) console.log("\nFailed entries:", JSON.stringify(failed, null, 2));
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
  if (writeMode) return runWrite(supabase, reportPath);
  return runDryRun(supabase);
}

run().catch((err) => {
  console.error("Backfill script crashed:", err);
  process.exit(1);
});
