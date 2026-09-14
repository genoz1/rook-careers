#!/usr/bin/env node
// backend/scripts/backfillJobStates.js
//
// One-time backfill: for every active, approved job that already has
// real job_lat/job_lng but a null `state`, resolve the real US
// state/DC/territory that coordinate falls inside, using a LOCAL,
// OFFLINE point-in-polygon check against the U.S. Census Bureau's real
// boundary data (us-atlas + topojson-client + @turf/boolean-point-in-
// polygon) — not a new Nominatim call. Verified directly that this
// dataset includes DC and all 5 US territories before this script was
// written.
//
// THREE MODES, each requiring an increasing level of explicit intent:
//
//   1. DRY RUN (default — just `node backend/scripts/backfillJobStates.js`)
//      Recomputes fresh from the live database. Zero writes. Produces a
//      timestamped report file for review.
//
//   2. WRITE (`--write --confirm --report=<path-to-a-dry-run-report>`)
//      Does NOT recompute anything. Reads the EXACT reviewed dry-run
//      report file you pass in and applies only what's already written
//      in it. Before touching each row, re-fetches its CURRENT
//      job_lat/job_lng/state from the database and compares them
//      against the current_job_lat/current_job_lng/current_state values
//      recorded in the report at dry-run time — if the row has changed
//      since the report was generated (e.g. re-ingested in the
//      meantime), that row is SKIPPED, not written, and recorded as
//      skipped in the write-results report. Produces a write-results
//      report (successful / skipped / failed IDs) — this is the file
//      needed for a later rollback.
//
//   3. ROLLBACK (`--rollback --confirm --report=<path-to-a-write-results-report>`)
//      Reads a write-results report from mode 2. For each row that was
//      successfully written, re-fetches its CURRENT state and
//      coordinates and clears `state` back to NULL ONLY IF the current
//      state still equals exactly what this backfill wrote AND the
//      coordinates are unchanged from what was recorded at write time.
//      Any row that fails that check is skipped, not forced.
//
// Every mode besides plain dry-run requires BOTH a mode flag (--write
// or --rollback) AND --confirm — a single flag alone does nothing.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const topojson = require("topojson-client");
const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default;
const usAtlas = require("us-atlas/states-10m.json");

// Exact IDs confirmed and listed during this project's assessment —
// must never receive a backfilled state under any mode. Kept as a
// literal, reviewable list rather than a database flag.
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
  "9e4116c4-a3c8-448b-b733-d3468b92f9f9", // "Remote, NH | Nashua, New Hampshire" — real NH job, wrong stored coordinate
];

const FIPS_TO_ABBR = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
  "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
  "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
  "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
  "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

function buildStatePolygons() {
  const geo = topojson.feature(usAtlas, usAtlas.objects.states);
  return geo.features.map((f) => ({ id: f.id, abbr: FIPS_TO_ABBR[f.id] || null, geometry: f }));
}

function findStateForPoint(lat, lng, statePolygons) {
  const point = { type: "Point", coordinates: [lng, lat] }; // GeoJSON order: [lng, lat]
  for (const state of statePolygons) {
    if (!state.abbr) continue;
    try {
      if (booleanPointInPolygon(point, state.geometry)) return state;
    } catch (_) {
      // A malformed geometry for one state must not abort the whole run.
    }
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
    console.error("--write requires --report=<path-to-a-dry-run-report.json>. Refusing to guess which report to apply. No changes made.");
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`Report file not found: ${reportPath}. No changes made.`);
    process.exit(1);
  }

  console.log(`WRITE MODE — applying EXACTLY what's in ${reportPath}. Not recomputing anything.\n`);
  const sourceReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const candidates = (sourceReport.entries || []).filter((e) => e.proposed_state && !KNOWN_BAD_RECORD_IDS.includes(e.job_id));
  console.log(`${candidates.length} row(s) in the report have a proposed_state and aren't a known-bad record.\n`);

  const successful = [];
  const skipped = [];
  const failed = [];

  for (const entry of candidates) {
    try {
      // Re-fetch the row's CURRENT state — never trust the report's
      // snapshot as still being true. If anything about the row has
      // changed since the dry run was generated, skip it rather than
      // overwrite based on stale information.
      const { data: current, error: fetchErr } = await supabase
        .from("jobs")
        .select("id, job_lat, job_lng, state")
        .eq("id", entry.job_id)
        .maybeSingle();
      if (fetchErr) { failed.push({ job_id: entry.job_id, error: fetchErr.message }); continue; }
      if (!current) { skipped.push({ job_id: entry.job_id, reason: "row no longer exists" }); continue; }

      const coordsUnchanged =
        String(current.job_lat) === String(entry.current_job_lat) &&
        String(current.job_lng) === String(entry.current_job_lng);
      const stateUnchanged = (current.state || null) === (entry.current_state || null);

      if (!coordsUnchanged || !stateUnchanged) {
        skipped.push({
          job_id: entry.job_id,
          reason: `row changed since the dry run — coords_unchanged=${coordsUnchanged}, state_unchanged=${stateUnchanged}`,
        });
        continue;
      }

      const { error: updateErr } = await supabase.from("jobs").update({ state: entry.proposed_state }).eq("id", entry.job_id);
      if (updateErr) { failed.push({ job_id: entry.job_id, error: updateErr.message }); continue; }

      successful.push({
        job_id: entry.job_id,
        written_state: entry.proposed_state,
        job_lat_at_write_time: current.job_lat,
        job_lng_at_write_time: current.job_lng,
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

  console.log(`ROLLBACK MODE — reverting exactly what ${reportPath} recorded as successful.\n`);
  const writeReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const toRollBack = writeReport.successful || [];
  console.log(`${toRollBack.length} row(s) recorded as successfully written in this report.\n`);

  const rolledBack = [];
  const skipped = [];
  const failed = [];

  for (const entry of toRollBack) {
    try {
      const { data: current, error: fetchErr } = await supabase
        .from("jobs")
        .select("id, job_lat, job_lng, state")
        .eq("id", entry.job_id)
        .maybeSingle();
      if (fetchErr) { failed.push({ job_id: entry.job_id, error: fetchErr.message }); continue; }
      if (!current) { skipped.push({ job_id: entry.job_id, reason: "row no longer exists" }); continue; }

      // Only clear state if it STILL equals exactly what this backfill
      // wrote, AND the coordinates are unchanged from write time — if
      // either has moved on (e.g. a fresh re-ingestion legitimately set
      // a new state since), rolling back would destroy newer, correct
      // data. Skip rather than force in that case.
      const stateStillMatches = current.state === entry.written_state;
      const coordsStillMatch =
        String(current.job_lat) === String(entry.job_lat_at_write_time) &&
        String(current.job_lng) === String(entry.job_lng_at_write_time);

      if (!stateStillMatches || !coordsStillMatch) {
        skipped.push({
          job_id: entry.job_id,
          reason: `row no longer matches what was written — state_still_matches=${stateStillMatches}, coords_still_match=${coordsStillMatch}`,
        });
        continue;
      }

      const { error: updateErr } = await supabase.from("jobs").update({ state: null }).eq("id", entry.job_id);
      if (updateErr) { failed.push({ job_id: entry.job_id, error: updateErr.message }); continue; }
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
