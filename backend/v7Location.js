// V7 boundary for legacy geocodes. Never invent a city coordinate from a
// work arrangement or state. The shared V6 scorer and database are untouched.
const {resolveUsStateCode, isUsEligibleJob} = require('./jobEligibility');
const {hasUnambiguousForeignCountryEvidence} = require('./locationTextRules');
const {extractGeocodableLocation} = require('./locationExtraction');
const {distanceMiles} = require('./geocoding');
const {matches, normalizeSelection} = require('../public/rook-job-classification');

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
  const points = job.location_evidence?.status === 'validated' && job.location_evidence.source_location === job.location_raw
    ? (job.location_evidence.locations || []).filter(p => typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng) && resolveUsStateCode(p.state)) : [];
  if (points.length && Number.isFinite(profile.home_lat) && Number.isFinite(profile.home_lng)) {
    const nearest = points.reduce((a,b) => distanceMiles(profile.home_lat,profile.home_lng,a.lat,a.lng) <= distanceMiles(profile.home_lat,profile.home_lng,b.lat,b.lng) ? a : b);
    job = {...job, job_lat:nearest.lat, job_lng:nearest.lng, state:nearest.state};
  }
  if (locationScope(job).imprecise || !isUsEligibleJob(job)) return null;
  if (![job.job_lat,job.job_lng,profile.home_lat,profile.home_lng].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  // Bounding-box corners can exceed the radius. Reject before scoreJob;
  // no work-style or territory preference can bypass the 300-mile boundary.
  if (distanceMiles(profile.home_lat,profile.home_lng,job.job_lat,job.job_lng) > 300) return null;
  return job;
}

function repairSnapshot(jobs, profile) {
  // Keep the original order, identities and scores of every valid result.
  const selected = normalizeSelection(profile.desired_industries);
  return (jobs || []).map(job => {
    const prepared = prepareJob(job,profile);
    if (!prepared || (selected.length && !matches(prepared,selected))) return null;
    if (prepared.job_lat === job.job_lat && prepared.job_lng === job.job_lng) return job;
    return {...prepared, match:require('./matching').scoreJob(prepared,profile), distance_miles:Math.round(distanceMiles(profile.home_lat,profile.home_lng,prepared.job_lat,prepared.job_lng))};
  }).filter(Boolean);
}

module.exports = {prepareJob,repairSnapshot,locationScope};
