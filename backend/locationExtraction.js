// backend/locationExtraction.js
//
// Extracts a clean, geocodable location string from a job's raw, often
// messy location_raw field. Pulled out of ingest.js into its own
// dependency-free module so it can be unit-tested directly — same
// reasoning as backend/redaction.js being extracted out of jobs.js
// earlier in this project.

function extractGeocodableLocation(locationRaw) {
  if (!locationRaw || !locationRaw.trim()) return null;
  const segments = locationRaw.split("|").map((s) => s.trim());
  let loc = segments[0];

  // Narrow fix, confirmed necessary by a real record ("Remote, NH |
  // Nashua, New Hampshire" — MWI Animal Health / Cencora, a genuine New
  // Hampshire job): when the first pipe-delimited segment is JUST
  // "Remote, <2-letter state>" and nothing else, and a second segment
  // exists that names an actual city + state, prefer the more specific
  // second segment. "NH" alone geocoded to a wrong, far-away point;
  // the job's own second segment already names the real city.
  // Deliberately scoped to this exact shape only — does NOT touch the
  // separate ~172-record "United States Remote Office | State, USA"
  // cluster (a different first-segment shape entirely, and a
  // location-accuracy issue explicitly reported separately, not fixed
  // here) or any other multi-location pattern. No general reordering
  // of pipe-delimited segments is introduced.
  const bareRemoteStateOnly = /^remote,\s*[a-z]{2}$/i.test(loc);
  if (bareRemoteStateOnly && segments.length > 1 && segments[1] && /^[A-Za-z][A-Za-z .]+,\s*[A-Za-z]/.test(segments[1])) {
    loc = segments[1];
  }

  // Skip useless placeholders
  if (/^(\d+\s+Locations?|Field\s+(Sales|Worker)\s*\()/i.test(loc)) return null;
  // Strip "Remote - " prefix → "Remote - Georgia" becomes "Georgia"
  loc = loc.replace(/^Remote\s*[-–]\s*/i, "").trim();
  // "USA - State - City" or "United States - State - City" → "City, State"
  const usaDash = loc.match(/^(?:USA?|United States?)\s*[-–]\s*([A-Za-z ]+?)\s*[-–]\s*([A-Za-z][A-Za-z0-9 .]+)/i);
  if (usaDash) {
    const state = usaDash[1].trim();
    const city = usaDash[2].replace(/[-–].*$/, "").trim();
    return city.length > 1 ? `${city}, ${state}` : state;
  }
  // Remove trailing ", us" / ", United States" country suffixes
  loc = loc.replace(/,\s*(us|usa|united states?)$/i, "").trim();
  // Skip if ends in a non-US 2-letter country code (e.g. ", no", ", de", ", cn")
  if (/,\s*[a-z]{2}$/i.test(loc) && !/,\s*(fl|ga|tx|ny|ca|oh|il|pa|nc|va|wa|ma|co|az|mi|tn|or|nj|md|mn|sc|al|la|wi|mo|ct|ok|ar|ia|ms|ks|ne|nv|id|mt|nd|sd|wv|wy|vt|nh|me|de|ri|ak|hi)$/i.test(loc)) return null;
  return loc.length > 2 ? loc : null;
}

module.exports = { extractGeocodableLocation };
