#!/usr/bin/env node
// scripts/regeocode-all-jobs.js
// One-time script: re-geocode ALL active jobs from location_raw.
// Overwrites whatever lat/lng the job board provided.
// Run: node scripts/regeocode-all-jobs.js
// Takes ~90 min for 5,000 jobs (Nominatim rate limit: 1 req/sec).

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { geocodeLocation } = require("../backend/geocoding");
const { mentionsNonUsCountry } = require("../backend/matching");

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

async function run() {
  console.log("Fetching all active approved jobs...");
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("id, title_original, location_raw, job_lat, job_lng")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .not("location_raw", "is", null);

  if (error) { console.error("DB error:", error.message); process.exit(1); }
  console.log(`Found ${jobs.length} jobs to process.\n`);

  let updated = 0, skipped = 0, failed = 0, foreign = 0;
  const start = Date.now();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const elapsed = Math.round((Date.now() - start) / 1000);
    const eta = i > 0 ? Math.round((elapsed / i) * (jobs.length - i)) : "?";
    process.stdout.write(`\r[${i+1}/${jobs.length}] updated=${updated} skipped=${skipped} failed=${failed} elapsed=${elapsed}s eta=${eta}s`);

    // Skip non-US jobs
    if (mentionsNonUsCountry(job.location_raw, null, job.title_original)) {
      foreign++; skipped++; continue;
    }

    const geoLoc = extractGeocodableLocation(job.location_raw);
    if (!geoLoc) { skipped++; continue; }

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
  }

  console.log(`\n\nDone.`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped} (${foreign} foreign, rest ungeocodable)`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${jobs.length}`);
  console.log(`  Time:     ${Math.round((Date.now()-start)/1000)}s`);
}

run().catch(err => { console.error(err); process.exit(1); });
