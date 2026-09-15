#!/usr/bin/env node
// backend/scripts/repairRemoteOfficeCluster.js
//
// Repairs the "United States Remote Office | <State>, USA"-shaped
// records: they all currently share one identical, wrong stored
// coordinate (a past geocoding attempt on the non-place first segment
// "United States Remote Office"), but their own second segment
// explicitly names a real US state.
//
// Direct instruction: do NOT geocode a state-center/state-capital
// coordinate for these. The repair is text-only:
//   - job_lat, job_lng -> NULL (the known-wrong shared coordinate is
//     removed; no replacement coordinate is invented at any precision)
//   - state -> the exact state name parsed from the record's own
//     second segment (e.g. "Florida" from "...| Florida, USA")
// Eligibility for these does NOT depend on this write at all — their
// own location_raw already contains explicit "United States"/"USA"
// language, which isUsEligibleJob() already treats as eligible via its
// existing text fallback with zero code changes. This script exists
// purely for data quality (a real, searchable state on the row), not
// to make anything newly visible.
//
// Does not call geocodeLocation() or Nominatim at all — this is a pure
// text-parsing + database write, no network calls of any kind.
//
// Does not touch scoring, ranking, matching, or distance logic in any
// way — job_lat/job_lng are set to NULL, the same "no coordinates"
// state every other locationless-but-eligible job already has; nothing
// about how scoreJob()/distanceMiles() handle that state is changed.
//
// THREE MODES, same pattern as the other scripts in this directory:
//   1. DRY RUN (default) — recomputes fresh, zero writes, produces a
//      report file.
//   2. WRITE (--write --confirm --report=<path-to-a-dry-run-report>)
//      Validates the report, applies only what's in it via a single
//      atomic conditional UPDATE per row (guard + write in one
//      operation), produces a write-results report.
//   3. ROLLBACK (--rollback --confirm --report=<path-to-a-write-results-report>)
//      Restores each row's original (wrong, shared) coordinate and
//      clears state, but only if the row still exactly matches what
//      this script wrote.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const US_REGION_NAMES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware",
  "Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky",
  "Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi",
  "Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico",
  "New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania",
  "Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont",
  "Virginia","Washington","West Virginia","Wisconsin","Wyoming",
  "District of Columbia","Puerto Rico","Guam","U.S. Virgin Islands",
  "American Samoa","Northern Mariana Islands",
];

function normalizeRegionToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}


const US_REGION_BY_TOKEN = new Map(
  US_REGION_NAMES.map((name) => [normalizeRegionToken(name), name])
);

// Confirmed spellings present in the live Remote Office cluster. Keep
// this list narrow: each alias was observed in the dry-run report and
// maps only to its unambiguous canonical state name.
const CONFIRMED_REGION_ALIASES = {
  massachusettes: "Massachusetts",
  louisana: "Louisiana",
  louvisana: "Louisiana",
};
for (const [alias, canonicalName] of Object.entries(CONFIRMED_REGION_ALIASES)) {
  US_REGION_BY_TOKEN.set(normalizeRegionToken(alias), canonicalName);
}

// Parses a region only from an exact comma-delimited token in the
// pipe-delimited location text. Exact matching prevents collisions such
// as "Virginia" inside "West Virginia" and avoids guessing from prose.
function parseExplicitState(locationRaw) {
  const segments = String(locationRaw || "").split("|").map((s) => s.trim());
  for (const segment of segments) {
    const tokens = segment.split(",").map(normalizeRegionToken).filter(Boolean);
    for (const token of tokens) {
      const regionName = US_REGION_BY_TOKEN.get(token);
      if (regionName) return regionName;
    }
  }
  return null;
}

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

  const rows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, location_raw, job_lat, job_lng, state")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .ilike("location_raw", "%remote office%|%")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) { console.error("DB error:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const cluster = rows.filter((r) => /remote office\s*\|/i.test(r.location_raw || ""));
  console.log(`Found ${cluster.length} "Remote Office | ..." records.\n`);

  const entries = [];
  let parseable = 0, unparseable = 0;
  for (const row of cluster) {
    const parsedState = parseExplicitState(row.location_raw);
    entries.push({
      job_id: row.id,
      location_raw: row.location_raw,
      current_job_lat: row.job_lat,
      current_job_lng: row.job_lng,
      current_state: row.state,
      parsed_state: parsedState,
      reason: parsedState
        ? `explicit state "${parsedState}" found in the record's own text`
        : "no state name found in text — left unchanged, not guessed",
    });
    if (parsedState) parseable++; else unparseable++;
  }

  const reportPath = path.join(__dirname, `repair-remote-office-dry-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    total_cluster_records: cluster.length,
    parseable, unparseable,
    entries,
  }, null, 2));

  console.log(`Parseable (state found in text): ${parseable}`);
  console.log(`Unparseable (no state found — left alone): ${unparseable}`);
  console.log(`\nReport written to: ${reportPath}`);
  console.log("\nDry run complete. No database rows were changed. Review the report, then re-run with:");
  console.log(`  node backend/scripts/repairRemoteOfficeCluster.js --write --confirm --report=${reportPath}`);
}

async function runWrite(supabase, reportPath) {
  if (!reportPath) { console.error("--write requires --report=<path>. No changes made."); process.exit(1); }
  if (!fs.existsSync(reportPath)) { console.error(`Report file not found: ${reportPath}. No changes made.`); process.exit(1); }

  const sourceReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (sourceReport.mode !== "dry-run") {
    console.error(`Refusing to proceed: expected a dry-run report, got mode ${JSON.stringify(sourceReport.mode)}.`);
    process.exit(1);
  }

  console.log(`WRITE MODE — applying EXACTLY what's in ${reportPath}. No geocoding call is made at any point.\n`);
  const candidates = (sourceReport.entries || []).filter((e) => e.parsed_state);
  console.log(`${candidates.length} row(s) have a parsed state and will be written.\n`);

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
        // NULL the known-wrong shared coordinate; write only the
        // explicitly parsed state. No coordinate of any kind invented.
        newValues: { job_lat: null, job_lng: null, state: entry.parsed_state },
      });
      if (error) { failed.push({ job_id: entry.job_id, error: error.message }); continue; }
      if (!data || data.length === 0) {
        skipped.push({ job_id: entry.job_id, reason: "row changed since the dry run — not overwriting" });
        continue;
      }
      successful.push({
        job_id: entry.job_id,
        original_job_lat: entry.current_job_lat,
        original_job_lng: entry.current_job_lng,
        original_state: entry.current_state,
        written_state: entry.parsed_state,
      });
    } catch (err) {
      failed.push({ job_id: entry.job_id, error: err.message });
    }
  }

  const writeResultsPath = path.join(__dirname, `repair-remote-office-write-results-${Date.now()}.json`);
  fs.writeFileSync(writeResultsPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    mode: "write",
    source_report: reportPath,
    successful, skipped, failed,
  }, null, 2));

  console.log(`Successful: ${successful.length} | Skipped: ${skipped.length} | Failed: ${failed.length}`);
  console.log(`\nWrite-results report written to: ${writeResultsPath}`);
  console.log("Rollback command:");
  console.log(`  node backend/scripts/repairRemoteOfficeCluster.js --rollback --confirm --report=${writeResultsPath}`);
}

async function runRollback(supabase, reportPath) {
  if (!reportPath) { console.error("--rollback requires --report=<path>. No changes made."); process.exit(1); }
  if (!fs.existsSync(reportPath)) { console.error(`Report file not found: ${reportPath}. No changes made.`); process.exit(1); }
  const writeReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (writeReport.mode !== "write") { console.error(`Expected a write-results report, got ${JSON.stringify(writeReport.mode)}.`); process.exit(1); }

  console.log(`ROLLBACK MODE — restoring the original shared coordinate for ${(writeReport.successful || []).length} row(s).\n`);
  const restored = [];
  const skipped = [];
  const failed = [];

  for (const entry of writeReport.successful || []) {
    try {
      const { data, error } = await guardedUpdate(supabase, {
        id: entry.job_id,
        expectedLat: null,
        expectedLng: null,
        expectedState: entry.written_state,
        newValues: { job_lat: entry.original_job_lat, job_lng: entry.original_job_lng, state: entry.original_state },
      });
      if (error) { failed.push({ job_id: entry.job_id, error: error.message }); continue; }
      if (!data || data.length === 0) { skipped.push({ job_id: entry.job_id, reason: "row no longer matches what was written" }); continue; }
      restored.push(entry.job_id);
    } catch (err) {
      failed.push({ job_id: entry.job_id, error: err.message });
    }
  }
  console.log(`Restored: ${restored.length} | Skipped: ${skipped.length} | Failed: ${failed.length}`);
}

async function run() {
  const { writeMode, rollbackMode, confirmed, reportPath } = parseArgs();
  if ((writeMode || rollbackMode) && !confirmed) { console.error("Refusing to run: --write or --rollback requires --confirm too. No changes made."); process.exit(1); }
  if (writeMode && rollbackMode) { console.error("Refusing to run: --write and --rollback cannot both be passed."); process.exit(1); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (rollbackMode) return runRollback(supabase, reportPath);
  if (writeMode) return runWrite(supabase, reportPath);
  return runDryRun(supabase);
}

if (require.main === module) {
  run().catch((err) => {
    console.error("Repair script crashed:", err);
    process.exit(1);
  });
}

module.exports = { parseExplicitState };
