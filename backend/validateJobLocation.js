const { geocodeLocation } = require('./geocoding');
const { extractGeocodableLocation } = require('./locationExtraction');
const { hasQualifiedUsLocation, US_COUNTRY_CODES, isUsEligibleJob } = require('./jobEligibility');
const { normalizeCountryCode, hasUnambiguousForeignCountryEvidence } = require('./locationTextRules');

// Runs independently of the AI budget. Every refresh replaces old provenance
// and clears an invalid point instead of retaining stale coordinates.
async function validateJobLocation(job, geocode = geocodeLocation, previous = null) {
  const raw = String(job.location_raw || '').trim();
  const country = normalizeCountryCode(job.location_evidence?.source_country_code);
  const evidence = { version: 1, source_country_code: country, source_location: raw, checked_at: new Date().toISOString(), status: 'unresolved' };
  const cleared = { job_lat: null, job_lng: null, state: null, location_evidence: evidence };
  if (hasUnambiguousForeignCountryEvidence(raw) || (country && !US_COUNTRY_CODES.has(country))) {
    evidence.status = 'foreign';
    return cleared;
  }
  if (!US_COUNTRY_CODES.has(country) && !hasQualifiedUsLocation(raw)) return cleared;
  // Reuse only points validated by this version against identical source
  // evidence. Legacy geocodes have no provenance and are never reused.
  const old = previous?.location_evidence;
  const age = Date.now() - Date.parse(old?.checked_at || '');
  if (old?.version === 1 && old.status === 'validated' && old.source_location === raw && normalizeCountryCode(old.source_country_code) === country && age >= 0 && age < 30 * 86400000 && isUsEligibleJob({...job,...previous})) {
    return {job_lat:previous.job_lat,job_lng:previous.job_lng,state:previous.state,location_evidence:old};
  }
  const text = extractGeocodableLocation(raw);
  if (!text) return cleared;
  let coords;
  try { coords = await geocode(text, { sourceCountryCode: country }); } catch { return cleared; }
  if (!coords) {
    // A failed lookup must not retain an old point or invent distance.
    evidence.status = 'unresolved';
    return cleared;
  }
  evidence.status = 'validated';
  evidence.geocoded_location = text;
  return { job_lat: coords.lat, job_lng: coords.lng, state: coords.state, location_evidence: evidence };
}
module.exports = { validateJobLocation };
