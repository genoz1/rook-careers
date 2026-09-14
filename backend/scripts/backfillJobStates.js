#!/usr/bin/env node
// backend/scripts/backfillJobStates.js
//
// One-time backfill: for every active, approved job that already has
// real job_lat/job_lng but a null `state` (the entire existing dataset,
// at the time this was written — see backend/ingest.js's now-fixed
// coords.state persistence bug), resolve the real US state/DC/territory
// that coordinate falls inside, using a LOCAL, OFFLINE point-in-polygon
// check against the U.S. Census Bureau's real boundary data — not a new
// Nominatim call. Verified directly (not assumed) that this dataset
// includes DC and all 5 US territories before this script was written.
//
// DRY-RUN BY DEFAULT. This script never writes to the database unless
// invoked with BOTH --write AND --confirm. Running it with no flags (or
// just node backend/scripts/backfillJobStates.js) only reads the
// database and writes a local JSON report file — zero database writes.
//
// Run (dry-run, safe, default):
//   node backend/scripts/backfillJobStates.js
//
// Run (write phase — NOT to be run without separate, explicit approval):
//   node backend/scripts/backfillJobStates.js --write --confirm
//
// The 10 known bad records (see the project's assessment doc) are
// EXCLUDED from this backfill entirely by ID — they must not receive a
// backfilled state; they're corrected separately (job_lat/job_lng/state
// all set to NULL) and stay fully unresolved until cleanly re-ingested
// under the fixed geocoding logic.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const topojson = require("topojson-client");
const booleanPointInPolygon = require("@turf/boolean-point-in-polygon").default;
const usAtlas = require("us-atlas/states-10m.json");

// Exact IDs confirmed and listed during this project's assessment —
// must never receive a backfilled state. Kept as a literal, reviewable
// list rather than a database flag, so this exclusion is visible
// directly in the script itself.
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
];

// FIPS state numeric code -> USPS abbreviation. Independent of both
// matching.js's STATE_ABBR and jobEligibility.js's own allowlist by
// design — this script's only job is to answer "what FIPS code does
// this point fall inside," and translate that to the same abbreviation
// jobEligibility.js already recognizes.
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
    if (!state.abbr) continue; // shouldn't happen — every FIPS code above is mapped
    try {
      if (booleanPointInPolygon(point, state.geometry)) {
        return state;
      }
    } catch (_) {
      // A malformed geometry for one state must not abort the whole run.
    }
  }
  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const writeMode = args.includes("--write");
  const confirmed = args.includes("--confirm");
  const isDryRun = !(writeMode && confirmed);

  if (writeMode && !confirmed) {
    console.error("Refusing to run: --write was passed without --confirm. No changes made. Re-run with both flags to actually write.");
    process.exit(1);
  }

  console.log(isDryRun ? "DRY RUN — no database writes will be made.\n" : "WRITE MODE — this WILL update the database.\n");

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log("Loading US state/DC/territory boundary polygons (us-atlas, offline, no network calls)...");
  const statePolygons = buildStatePolygons();
  console.log(`  Loaded ${statePolygons.length} polygons.\n`);

  console.log("Fetching eligible job rows (active, approved, has coordinates, not a known-bad record)...");
  const allRows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, title_original, location_raw, job_lat, job_lng, state")
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
  const excludedCount = allRows.length - rows.length;
  console.log(`  Fetched ${allRows.length} rows with coordinates; excluded ${excludedCount} known-bad record(s); processing ${rows.length}.\n`);

  const report = [];
  let matched = 0;
  let unmatched = 0;
  let alreadyHadState = 0;

  for (const row of rows) {
    if (row.state) {
      alreadyHadState++;
      continue; // don't touch a row that already has a state — this backfill is additive only
    }
    const lat = parseFloat(row.job_lat);
    const lng = parseFloat(row.job_lng);
    const match = findStateForPoint(lat, lng, statePolygons);
    if (match) {
      matched++;
      report.push({
        job_id: row.id,
        location_raw: row.location_raw,
        current_job_lat: row.job_lat,
        current_job_lng: row.job_lng,
        current_state: row.state,
        proposed_state: match.abbr,
        matched_fips: match.id,
        reason: `point (${lat}, ${lng}) falls inside the ${match.abbr} (FIPS ${match.id}) polygon`,
      });
    } else {
      unmatched++;
      report.push({
        job_id: row.id,
        location_raw: row.location_raw,
        current_job_lat: row.job_lat,
        current_job_lng: row.job_lng,
        current_state: row.state,
        proposed_state: null,
        matched_fips: null,
        reason: "point did not fall inside any US state/DC/territory polygon — needs manual review",
      });
    }
  }

  const reportPath = path.join(__dirname, `backfill-dry-run-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: isDryRun ? "dry-run" : "write",
    total_rows_with_coordinates: allRows.length,
    excluded_known_bad_records: excludedCount,
    already_had_state_skipped: alreadyHadState,
    matched,
    unmatched,
    entries: report,
  }, null, 2));

  console.log(`Matched:   ${matched}`);
  console.log(`Unmatched: ${unmatched} (no polygon contained the point — needs manual review)`);
  console.log(`Already had a state (skipped, untouched): ${alreadyHadState}`);
  console.log(`\nReport written to: ${reportPath}`);

  if (isDryRun) {
    console.log("\nDry run complete. No database rows were changed. Review the report, then re-run with --write --confirm to apply.");
    return;
  }

  console.log("\nApplying writes...");
  let written = 0;
  for (const entry of report) {
    if (!entry.proposed_state) continue;
    const { error } = await supabase.from("jobs").update({ state: entry.proposed_state }).eq("id", entry.job_id);
    if (error) {
      console.error(`  Failed to write state for ${entry.job_id}: ${error.message}`);
    } else {
      written++;
    }
  }
  console.log(`\nWrote state to ${written} rows. Rollback: re-run with the saved report's job_id list, setting state back to NULL for each.`);
}

run().catch((err) => {
  console.error("Backfill script crashed:", err);
  process.exit(1);
});
