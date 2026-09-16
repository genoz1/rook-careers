// V7 boundary for legacy geocodes. Never invent a city coordinate from a
// work arrangement or state. The shared V6 scorer and database are untouched.
const {resolveUsStateCode, isUsEligibleJob} = require('./jobEligibility');
const {hasUnambiguousForeignCountryEvidence} = require('./locationTextRules');
const {extractGeocodableLocation} = require('./locationExtraction');
const {distanceMiles} = require('./geocoding');

function locationScope(job) {
  const raw = String(job.location_raw || '').trim();
  const state = resolveUsStateCode(extractGeocodableLocation(raw));
  const withoutArrangement = raw.replace(/\b(united states(?: of america)?|usa|us|remote|office|virtual|wfh|telecommute|home|field|worker)\b/gi, '').replace(/[\s,|()–—-]+/g, ' ').trim();
  const officeState = /^United States Remote Office\s*\|\s*([^,|]+),\s*USA?$/i.exec(raw);
  const stateOnly = state || resolveUsStateCode(withoutArrangement) || (officeState && resolveUsStateCode(officeState[1]));
  const generic = !withoutArrangement;
  // This exact point is the hamlet of Remote, Oregon, not a job territory.
  const remoteHamlet = /remote/i.test(raw) && Math.abs(Number(job.job_lat) - 43.0059455) < 0.0001 && Math.abs(Number(job.job_lng) + 123.8925908) < 0.0001;
  return {stateOnly, imprecise:!!(stateOnly || generic || remoteHamlet)};
}

function prepareJob(job, profile) {
  if (!job || hasUnambiguousForeignCountryEvidence(job.location_raw)) return null;
  // Employer posting verified 2026-09-16: Tandem's bare Leiden is an on-site
  // Dutch role, despite legacy Nevada coordinates. Explicit US qualifiers
  // remain distinct; do not build a guessed world-city blacklist.
  if (/^(leiden|barcelona)$/i.test(String(job.location_raw || '').trim())) return null;
  if (locationScope(job).imprecise || !isUsEligibleJob(job)) return null;
  if (![job.job_lat,job.job_lng,profile.home_lat,profile.home_lng].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  // Bounding-box corners can exceed the radius. Reject before scoreJob;
  // no work-style or territory preference can bypass the 300-mile boundary.
  if (distanceMiles(profile.home_lat,profile.home_lng,job.job_lat,job.job_lng) > 300) return null;
  return job;
}

function repairSnapshot(jobs, profile) {
  // Keep the original order, identities and scores of every valid result.
  return (jobs || []).filter(job => prepareJob(job,profile));
}

module.exports = {prepareJob,repairSnapshot,locationScope};
