const {geocodeLocation}=require('./geocoding');
const {resolveLocation,cityQuery,pointMatchesCity,VERSION}=require('./jobLocationScope');
const {normalizeCountryCode}=require('./locationTextRules');
const crypto=require('crypto');
const normalized=s=>String(s||'').trim().replace(/\s+/g,' ');
async function validateJobLocation(job,geocode=geocodeLocation,previous=null) {
  const old=previous?.location_evidence;
  const country=normalizeCountryCode(job.location_evidence?.source_country_code);
  const same=old && old.source_location===normalized(job.location_raw) && (!country||normalizeCountryCode(old.source_country_code)===country);
  const descriptionHash=crypto.createHash('md5').update(String(job.description_text||'')).digest('hex');
  const age=Date.now()-Date.parse(old?.checked_at||'');
  const descriptionBacked=old?.scope?.reason==='explicit_description_territory'||['remote_us','national_us'].includes(old?.scope?.kind);
  // Every v3 decision records the description hash because a later edit can
  // introduce higher-priority explicit territory evidence even when the ATS
  // location and title did not change.
  const explicitCity=/,\s*us$/i.test(normalized(job.location_raw)) && cityQuery(job.location_raw);
  const points=old?.locations?.length ? old.locations : [{lat:previous?.job_lat,lng:previous?.job_lng,state:previous?.state}];
  const cityValid=!explicitCity || points.some(p=>pointMatchesCity(p,explicitCity));
  if(same&&old.version===VERSION&&old.source_title===normalized(job.title_original)&&old.source_description_hash===descriptionHash&&old.status==='validated'&&!old.incomplete&&cityValid&&age>=0&&age<30*86400000)return {job_lat:previous.job_lat,job_lng:previous.job_lng,state:previous.state,location_evidence:old};
  // Preserve validated legacy points only against exactly the same source.
  const input=same&&!descriptionBacked?{...job,job_lat:previous.job_lat,job_lng:previous.job_lng,state:previous.state,location_evidence:{...old,version:1,scope:undefined}}:job;
  const resolved=await resolveLocation(input,geocode);
  // Keep LinkedIn presence annotation across location re-validation. The
  // checker writes location_evidence.linkedin_presence; adapters never set it.
  if(old?.linkedin_presence&&resolved?.location_evidence&&!resolved.location_evidence.linkedin_presence){
    resolved.location_evidence={...resolved.location_evidence,linkedin_presence:old.linkedin_presence};
  }
  return resolved;
}
module.exports={validateJobLocation};
