#!/usr/bin/env node
// scripts/regeocode-all-jobs.js
// One-time script: re-geocode ALL active jobs from location_raw.
// Overwrites whatever lat/lng the job board provided.
// Run: node scripts/regeocode-all-jobs.js
// Takes ~90 min for 5,000 jobs (Nominatim rate limit: 1 req/sec).
// Safe to re-run — tracks progress in .regeocode-progress.json and
// picks up where it left off if interrupted.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { geocodeLocation } = require("../backend/geocoding");
const { mentionsNonUsCountry } = require("../backend/matching");
const fs = require("fs");

const PROGRESS_FILE = ".regeocode-progress.json";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function extractGeocodableLocation(locationRaw) {
  if (!locationRaw || !locationRaw.trim()) return null;
  let loc = locationRaw.split("|")[0].trim();
  if (/^(\d+\s+Locations?|Field\s+(Sales|Worker)\s*\()/i.test(loc)) return null;
  loc = loc.replace(/^Remote\s*[-–]\s*/i, "").trim();
  const usaDash = loc.match(/^(?:USA?|United States?)\s*[-–]\s*([A-Za-z ]+?)\s*[-–]\s*([A-Za-z][A-Za-z0-9 .]+)/i);
  if (usaDash) {
    const state = usaDash[1].trim();
    const city = usaDash[2].replace(/[-–].*$/, "").trim();
    return city.length > 1 ? `${city}, ${state}` : state;
  }
  loc = loc.replace(/,\s*(us|usa|united states?)$/i, "").trim();
  if (/,\s*[a-z]{2}$/i.test(loc) && !/,\s*(fl|ga|tx|ny|ca|oh|il|pa|nc|va|wa|ma|co|az|mi|tn|or|nj|md|mn|sc|al|la|wi|mo|ct|ok|ar|ia|ms|ks|ne|nv|id|mt|nd|sd|wv|wy|vt|nh|me|de|ri|ak|hi)$/i.test(loc)) return null;
  return loc.length > 2 ? loc : null;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      console.log(`Resuming from job ${p.lastIndex + 1} (${p.updated} already updated, ${p.skipped} skipped)`);
      return p;
    }
  } catch(_) {}
  return { lastIndex: -1, updated: 0, skipped: 0, failed: 0, foreign: 0 };
}

function saveProgress(progress) {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress)); } catch(_) {}
}

async function run() {
  console.log("Fetching all active approved jobs...");
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("id, title_original, location_raw, job_lat, job_lng")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .not("location_raw", "is", null)
    .order("id");

  if (error) { console.error("DB error:", error.message); process.exit(1); }
  console.log(`Found ${jobs.length} jobs total.\n`);

  const progress = loadProgress();
  let { lastIndex, updated, skipped, failed, foreign } = progress;
  const start = Date.now();

  for (let i = lastIndex + 1; i < jobs.length; i++) {
    const job = jobs[i];
    const elapsed = Math.round((Date.now() - start) / 1000);
    const done = i - (lastIndex + 1);
    const eta = done > 0 ? Math.round((elapsed / done) * (jobs.length - i)) : "?";
    process.stdout.write(`\r[${i+1}/${jobs.length}] updated=${updated} skipped=${skipped} failed=${failed} elapsed=${elapsed}s eta=${eta}s  `);

    if (mentionsNonUsCountry(job.location_raw, null, job.title_original)) {
      foreign++; skipped++;
      saveProgress({ lastIndex: i, updated, skipped, failed, foreign });
      continue;
    }

    const geoLoc = extractGeocodableLocation(job.location_raw);
    if (!geoLoc) {
      skipped++;
      saveProgress({ lastIndex: i, updated, skipped, failed, foreign });
      continue;
    }

    try {
      const coords = await geocodeLocation(geoLoc);
      if (coords) {
        await supabase.from("jobs").update({ job_lat: coords.lat, job_lng: coords.lng }).eq("id", job.id);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
    }

    saveProgress({ lastIndex: i, updated, skipped, failed, foreign });
  }

  // Done — remove progress file
  try { fs.unlinkSync(PROGRESS_FILE); } catch(_) {}

  console.log(`\n\nDone.`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped} (${foreign} foreign, rest ungeocodable)`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${jobs.length}`);
  console.log(`  Time:     ${Math.round((Date.now()-start)/1000)}s`);
}

run().catch(err => { console.error(err); process.exit(1); });
