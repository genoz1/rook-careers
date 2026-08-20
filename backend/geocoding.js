// Geocoding — converts a ZIP code or a free-text location ("Tampa, FL")
// into real latitude/longitude, using OpenStreetMap's Nominatim, a
// genuinely free, public, no-API-key geocoding service (distinct from
// something like Google's Geocoding API, which requires billing).
//
// Nominatim's usage policy requires a descriptive User-Agent and caps
// requests at roughly 1/second for casual use — both respected here.
// This is why geocoding only ever happens ONCE per candidate ZIP (when
// they save it in Settings) and ONCE per job (at ingestion time, cached
// forever after in job_lat/job_lng) — never live during scoring, which
// stays pure math against already-stored coordinates, consistent with
// the precomputed-scoring architecture built earlier tonight.
//
// NOTE: like every other external integration built tonight, this has
// not been tested against the live Nominatim API from the environment
// this was written in — no network access to openstreetmap.org there.
// Built to Nominatim's documented request/response shape; treat the
// first real geocoding call as the real test.

const USER_AGENT = "ROOK-Careers/1.0 (rookcareers.com; job-matching platform)";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_DELAY_BETWEEN_CALLS_MS = 1100; // stays under Nominatim's ~1 req/sec policy

let lastCallAt = 0;
async function throttle() {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_DELAY_BETWEEN_CALLS_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_BETWEEN_CALLS_MS - elapsed));
  }
  lastCallAt = Date.now();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode a US ZIP code to {lat, lng}, or null if not found/on error.
 */
async function geocodeZip(zip) {
  if (!zip || !/^\d{5}$/.test(String(zip).trim())) return null;
  await throttle();
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&country=us&format=json&limit=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const results = await res.json();
    const first = results?.[0];
    if (!first) return null;
    return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
  } catch {
    return null;
  }
}

/**
 * Geocode a free-text location ("Tampa, FL", "Orlando, Florida") to
 * {lat, lng}, or null if not found/on error. Deliberately doesn't retry
 * or get clever about parsing messy strings ("Multiple US Locations",
 * "Field Based - Southeast") — those will just fail to geocode, which is
 * fine: proximity scoring is a bonus on top of state-matching, not a
 * replacement for it, so a job with no coordinates just doesn't get the
 * bonus rather than breaking anything.
 */
async function geocodeLocation(locationText) {
  if (!locationText || !locationText.trim()) return null;
  await throttle();
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationText)}&countrycodes=us&format=json&limit=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const results = await res.json();
    const first = results?.[0];
    if (!first) return null;
    return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
  } catch {
    return null;
  }
}

/**
 * Great-circle distance between two points, in miles (haversine formula).
 */
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth's radius in miles
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

module.exports = { geocodeZip, geocodeLocation, distanceMiles };
