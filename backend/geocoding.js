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
// job-location geocoding (geocodeLocation, below) was found to have two
// real, confirmed-live defects, root-caused by direct diagnostic testing
// against the real Nominatim API rather than assumed:
//   1. A bare foreign country name ("Tanzania", "Kuwait", etc.) can
//      match that country's own embassy — a real place physically
//      located inside the US, so it passes the existing countrycodes=us
//      restriction, but it is not a geographic job location. Confirmed
//      for 9 of 9 tested countries; every match returned Nominatim
//      category "office"/"diplomatic", never a genuine place.
//   2. The original request used format=json with no addressdetails,
//      so address.state was never available to persist in the first
//      place — a separate, compounding defect from (1), independently
//      responsible for every job's `state` column being null regardless
//      of whether geocoding succeeded.
// Both are fixed here: a pre-geocoding text check rejects bare generic
// remote terms and unambiguous foreign-country text before ever calling
// Nominatim; the request now uses format=jsonv2&addressdetails=1
// specifically (jsonv2 is required to receive the result-type field as
// `category` rather than the older `class` name); and only `category`
// "place" or "boundary" results are accepted — both values verified
// necessary via direct testing (a real city can return either, e.g.
// Washington DC returned "place" while every other tested city
// returned "boundary").
//
// NOTE: geocodeZip() (candidate home-ZIP geocoding, used in Settings)
// is intentionally NOT changed here — it's a different input shape
// (a 5-digit US ZIP, not free text) with no equivalent foreign-country
// or bare-generic-term risk, and is out of scope for this project.

const { hasUnambiguousForeignCountryEvidence, isBareGenericRemoteTerm } = require("./locationTextRules");
const { resolveUsStateCode } = require("./jobEligibility");

const USER_AGENT = "ROOK-Careers/1.0 (rookcareers.com; job-matching platform)";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_DELAY_BETWEEN_CALLS_MS = 1100; // stays under Nominatim's ~1 req/sec policy

// Only a genuine geographic place should ever be accepted for a job
// location. Verified directly against 12 real inputs (round 1-3 of this
// project's diagnostics): every one of the 10 known-bad records returned
// "office", "highway", "building", or "water"/"waterway"; every genuine
// city/state/DC/Puerto Rico test returned "place" or "boundary". Both
// values are required — narrowing to one alone would wrongly reject the
// other (confirmed: Washington DC returned "place", not "boundary",
// while every other tested city returned "boundary").
const ACCEPTABLE_RESULT_CATEGORIES = new Set(["place", "boundary"]);

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
 * Geocode a US ZIP code to {lat, lng, state}, or null if not found/on
 * error. `state` is the full state name (e.g. "Florida") as Nominatim
 * reports it, not an abbreviation — callers that need an abbreviation
 * should run it through matching.js's stateAbbrFromName().
 *
 * Unchanged in this project — see the NOTE above.
 */
async function geocodeZip(zip) {
  if (!zip || !/^\d{5}$/.test(String(zip).trim())) return null;
  await throttle();
  try {
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&country=us&format=json&limit=1&addressdetails=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const results = await res.json();
    const first = results?.[0];
    if (!first) return null;
    return { lat: parseFloat(first.lat), lng: parseFloat(first.lon), state: first.address?.state || null };
  } catch {
    return null;
  }
}

/**
 * Geocode a free-text job location ("Tampa, FL", "Orlando, Florida") to
 * {lat, lng, state}, or null if not found, rejected, or on error.
 *
 * Two rejection paths run BEFORE any Nominatim call is made (no network
 * cost for either):
 *   - isBareGenericRemoteTerm: "Remote", "WFH", "Virtual", "Telecommute"
 *     alone. Confirmed necessary — a live query for the bare word
 *     "Remote" returns a real match (a hamlet in Coos County, Oregon),
 *     which the result-type check alone would NOT catch, since a hamlet
 *     is a legitimate "place"-category result.
 *   - hasUnambiguousForeignCountryEvidence: a bare or clearly-named
 *     foreign country (Georgia special-cased — see locationTextRules.js).
 *     This always wins even when US-sounding text is also present
 *     elsewhere in the same string (e.g. "United States / Canada" is
 *     rejected, not accepted) — direct instruction.
 *
 * After a successful geocode, the result's `category` must be "place"
 * or "boundary" (see ACCEPTABLE_RESULT_CATEGORIES above), the returned
 * lat/lng must both be finite numbers, and the result's address.state
 * must resolve through jobEligibility.js's explicit US state/DC/
 * territory allowlist — any one of these failing discards the result
 * entirely, same as a zero-result response. A "place"/"boundary"
 * category alone is necessary but not sufficient; direct instruction.
 */
async function geocodeLocation(locationText) {
  if (!locationText || !locationText.trim()) return null;
  if (isBareGenericRemoteTerm(locationText)) return null;
  if (hasUnambiguousForeignCountryEvidence(locationText)) return null;

  await throttle();
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationText)}&countrycodes=us&format=jsonv2&addressdetails=1&limit=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const results = await res.json();
    const first = results?.[0];
    if (!first) return null;
    if (!ACCEPTABLE_RESULT_CATEGORIES.has(first.category)) return null;

    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    // Reject non-finite coordinates outright — a malformed or missing
    // lat/lon in Nominatim's response must never be silently accepted
    // as if it were a real point.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // A "place"/"boundary"-category result is necessary but not
    // sufficient — it must ALSO carry a state/DC/territory that
    // resolves through jobEligibility.js's explicit allowlist. Without
    // this, an accepted result with no state at all (or a foreign
    // state-equivalent Nominatim happened to return) would still
    // produce unusable or wrong data. Direct instruction.
    const stateName = first.address?.state;
    if (!resolveUsStateCode(stateName)) return null;

    return { lat, lng, state: stateName };
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
