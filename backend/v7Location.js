// V7 boundary for legacy geocodes. Never invent a city coordinate from a
// work arrangement or state. The shared V6 scorer and database are untouched.
const {resolveUsStateCode, isUsEligibleJob} = require('./jobEligibility');
const {hasUnambiguousForeignCountryEvidence} = require('./locationTextRules');
const {extractGeocodableLocation} = require('./locationExtraction');
const {distanceMiles} = require('./geocoding');
const {scoreJob} = require('./matching');

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
  const scope = locationScope(job);
  const clean = scope.imprecise ? {...job, job_lat:null, job_lng:null, city:null,
    state:scope.stateOnly || null, distance_miles:null} : job;
  const eligible = scope.stateOnly || isUsEligibleJob(clean);
  if (!eligible) return null;
  const choices = profile.territory_size_preferences || [profile.territory_size_preference];
  const nearbyOnly = choices.some(c => c === 'local' || c === 'regional') && !choices.some(c => c === 'national' || c === 'remote');
  if (nearbyOnly) {
    if (scope.stateOnly) {
      if (scope.stateOnly !== resolveUsStateCode(profile.home_state)) return null;
    } else {
      if (![clean.job_lat,clean.job_lng,profile.home_lat,profile.home_lng].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
      if (distanceMiles(profile.home_lat,profile.home_lng,clean.job_lat,clean.job_lng) > 300) return null;
    }
  }
  return clean;
}

function repairSnapshot(jobs, profile) {
  return (jobs || []).flatMap(job => {
    const clean = prepareJob(job,profile);
    if (!clean) return [];
    // Preserve every unaffected score and result identity. Only a rejected
    // coordinate changes the scorer's input, using the original four answers.
    return [clean === job ? job : {...clean,match:scoreJob(clean,profile)}];
  }).sort((a,b) => (b.match?.overall_score || 0) - (a.match?.overall_score || 0));
}

module.exports = {prepareJob,repairSnapshot,locationScope};
