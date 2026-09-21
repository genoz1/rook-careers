// V7 boundary for legacy geocodes. Never invent a city coordinate from a
// work arrangement or state. The shared V6 scorer and database are untouched.
const {resolveUsStateCode, isUsEligibleJob} = require('./jobEligibility');
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

function allowsBroadLocations(profile) {
  const choices = Array.isArray(profile.territory_size_preferences) ? profile.territory_size_preferences : [profile.territory_size_preference];
  return choices.some(choice => ['national','remote'].includes(String(choice || '').toLowerCase()));
}

function prepareJob(job, profile) {
  if (!job || !isUsEligibleJob(job)) return null;
  if (/^(leiden|barcelona)$/i.test(String(job.location_raw || '').trim())) return null;
  const {classifyLocation,validPoint,VERSION} = require('./jobLocationScope');
  const scope=classifyLocation(job);
  const evidence=job.location_evidence;
  const trusted=evidence?.version===VERSION && evidence.source_location===String(job.location_raw||'').trim().replace(/\s+/g,' ') && evidence.source_title===String(job.title_original||'').trim().replace(/\s+/g,' ');
  const choices=profile.territory_size_preferences || [profile.territory_size_preference];
  const homeState=resolveUsStateCode(profile.home_state);
  const scoped=(kind)=>({...job,job_lat:null,job_lng:null,geographic_eligibility:{kind},territory_match:kind==='territory'?'state_overlap':undefined});
  // Nationwide scope requires reviewed source evidence; a user's broad
  // preference cannot turn an unrelated office or unknown territory into one.
  if(['remote_us','national_us'].includes(scope.kind) && (!homeState || (scope.states?.length && !scope.states.includes(homeState))))return null;
  if(trusted && scope.kind==='remote_us') return choices.includes('remote') ? scoped('remote_us') : null;
  if(trusted && scope.kind==='national_us') return choices.includes('national') ? scoped('national_us') : null;
  if(scope.kind==='foreign')return null;
  if(scope.kind==='unresolved') {
    // Preserve provenance-free qualified city records during migration only.
    if(evidence || locationScope(job).imprecise || !/,\s*[A-Z]{2}(?:\s|$)/.test(String(job.location_raw||''))) return null;
  }
  const stateEligible=scope.states?.includes(homeState);
  if(scope.kind==='territory') return stateEligible ? scoped('territory') : null;
  if(locationScope(job).imprecise && !trusted) return null;
  const points = evidence?.status==='validated' && evidence.source_location===String(job.location_raw||'').trim()
    ? (evidence.locations || []).filter(validPoint) : [];
  if(!points.length && validPoint({lat:job.job_lat,lng:job.job_lng,state:job.state})) points.push({lat:job.job_lat,lng:job.job_lng,state:job.state});
  if(!points.length || ![profile.home_lat,profile.home_lng].every(Number.isFinite))return stateEligible ? scoped('territory') : null;
  const nearest=points.reduce((a,b)=>distanceMiles(profile.home_lat,profile.home_lng,a.lat,a.lng)<=distanceMiles(profile.home_lat,profile.home_lng,b.lat,b.lng)?a:b);
  // Retain the established legacy-title conflict guard until those older
  // rows have source-backed scope. Do not use state centroids as boundaries.
  if(!trusted) {
    const legacyCities={'south florida':[25.9,-80.3],miami:[25.77,-80.19],'fort lauderdale':[26.12,-80.14],'palm beach':[26.71,-80.05],pensacola:[30.42,-87.22],tallahassee:[30.44,-84.28],jacksonville:[30.33,-81.66]};
    const title=String(job.title_original||'').toLowerCase();
    if(Object.entries(legacyCities).some(([name,[lat,lng]])=>title.includes(name)&&distanceMiles(nearest.lat,nearest.lng,lat,lng)>80))return null;
  }
  const distance=distanceMiles(profile.home_lat,profile.home_lng,nearest.lat,nearest.lng);
  if(distance>300)return stateEligible ? scoped('territory') : null;
  return {...job,job_lat:nearest.lat,job_lng:nearest.lng,state:nearest.state,geographic_eligibility:{kind:'local',distance_miles:distance}};
}

function repairSnapshot(jobs, profile) {
  // Keep the original order, identities and scores of every valid result.
  const selected = normalizeSelection(profile.desired_industries);
  return (jobs || []).map(job => {
    const prepared = prepareJob(job,profile);
    if (!prepared || (selected.length && !matches(prepared,selected))) return null;
    if (prepared.job_lat === job.job_lat && prepared.job_lng === job.job_lng) return job;
    return {...prepared, match:require('./matching').scoreJob(prepared,profile,{geography:prepared.geographic_eligibility}), distance_miles:prepared.job_lat == null ? null : Math.round(distanceMiles(profile.home_lat,profile.home_lng,prepared.job_lat,prepared.job_lng))};
  }).filter(Boolean);
}

module.exports = {prepareJob,repairSnapshot,locationScope,allowsBroadLocations};
