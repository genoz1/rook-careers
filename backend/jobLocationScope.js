// Source-backed location classification. Remote is a work arrangement, not
// evidence that a field representative may live anywhere in the country.
const {resolveUsStateCode,hasQualifiedUsLocation,US_COUNTRY_CODES} = require('./jobEligibility');
const {hasUnambiguousForeignCountryEvidence,normalizeCountryCode} = require('./locationTextRules');
const zipcodes = require('zipcodes');
const countries = require('i18n-iso-countries');
const VERSION = 2;
const clean = s => String(s || '').trim().replace(/\s+/g,' ');
const key = s => clean(s).toLowerCase().replace(/[^a-z0-9]/g,'');
const cityIndex=new Map(Object.values(zipcodes.codes).map(z=>[key(z.city)+'|'+z.state,z]));
const validPoint = p => p && [p.lat,p.lng].every(Number.isFinite) && Math.abs(p.lat)<=90 && Math.abs(p.lng)<=180 && resolveUsStateCode(p.state);
function stateOnly(raw) {
  return resolveUsStateCode(clean(raw).replace(/\b(united states(?: of america)?|usa|us|remote|office|virtual|home|based|field|work|from|any city|state of|address|loc)\b/gi,'').replace(/[\d_>,:()|–—-]+/g,' ').trim());
}
// Exact city/state entries only: do not guess a state for a bare city, or
// geocode a state centroid as though it were an employer's street address.
function cityQuery(segment) {
  let s=clean(segment).replace(/\bUnited States(?: of America)?\b|\bUSA\b|\bUS\b/g,'').replace(/\((?:remote|hybrid|on.?site)\)/gi,'').replace(/^Remote\s*[-,]\s*/i,'').replace(/[,\s]+$/,'').trim();
  s=s.replace(/^[-,\s]+/,'');
  const reversed=/^([^,]+),\s*([^,]+)$/.exec(s);
  if(reversed && resolveUsStateCode(reversed[1]) && !resolveUsStateCode(reversed[2])) s=reversed[2]+', '+reversed[1];
  const stateCity=/^([A-Za-z ]+?)\s*-\s*([A-Za-z .'-]+)$/.exec(s);
  if(stateCity && resolveUsStateCode(stateCity[1])) s=stateCity[2]+', '+stateCity[1];
  let m=/^(.+?)\s*[,()]\s*([A-Za-z .]+)\)?$/.exec(s);
  if(!m) m=/^(.+?)\s+([A-Z]{2})$/.exec(s);
  if(!m) return null;
  const state=resolveUsStateCode(m[2]); if(!state) return null;
  const city=clean(m[1]);
  const entry=cityIndex.get(key(city)+'|'+state);
  return entry ? {query:`${entry.city}, ${state}`,city:entry.city,state} : null;
}
function classifyLocation(job) {
  const raw=clean(job.location_raw), country=normalizeCountryCode(job.location_evidence?.source_country_code);
  if(hasUnambiguousForeignCountryEvidence(raw)||(country&&!US_COUNTRY_CODES.has(country))) return {kind:'foreign',reason:'explicit_foreign_evidence'};
  const suffixCountry=/,\s*([a-z]{2})$/.exec(raw);
  if(suffixCountry && raw.split(',').length>=3 && countries.isValid(suffixCountry[1].toUpperCase()) && !US_COUNTRY_CODES.has(suffixCountry[1].toUpperCase())) return {kind:'foreign',reason:'explicit_source_country_suffix'};
  const old=job.location_evidence;
  if(old?.version===VERSION && clean(old.source_location)===raw && old.source_title===clean(job.title_original) && old.scope) return old.scope;
  if(!raw) return {kind:'unresolved',reason:'empty_source_location'};
  const us=US_COUNTRY_CODES.has(country)||hasQualifiedUsLocation(raw);
  if(!us) return {kind:'unresolved',reason:'country_or_city_ambiguous'};
  const structured=job.extraction_evidence;
  if(job.source_type==='custom_html'&&structured?.location_scope==='state_or_region') {
    const states=[...new Set((structured.territories||[]).flatMap(t=>t.states||[]).map(resolveUsStateCode).filter(Boolean))];
    if(states.length)return {kind:'territory',states,reason:'source_structured_territory'};
  }
  const title=clean(job.title_original);
  const suffix=title.split(/\s+[–—-]\s+/).pop();
  const titleStates=suffix.split(/\s*[/&,]\s*/).map(s=>/^[A-Z]{2}$/.test(s)?resolveUsStateCode(s):null);
  if(titleStates.length>1&&titleStates.every(Boolean)) return {kind:'territory',states:[...new Set(titleStates)],reason:'explicit_title_state_list'};
  const titleCity=suffix!==title?cityQuery(suffix):null;
  // A specific sales territory in the title takes precedence over an ATS
  // home-office/HQ location. Restrict this to explicitly field/sales roles.
  if(titleCity&&/sales|territory|account|clinical|specialist/i.test(title)) return {kind:'local',queries:[titleCity],reason:'explicit_title_city_state'};
  const segments=raw.split(/[|;]/).map(clean).filter(Boolean);
  const queries=segments.map(cityQuery).filter(Boolean);
  if(queries.length) return {kind:'local',queries,states:segments.map(stateOnly).filter(Boolean),reason:queries.length>1?'multiple_city_locations':'explicit_city_state',partial:queries.length<segments.filter(s=>!/^remote(?:\s*[-,]\s*)?(?:US|USA|United States)?$/i.test(s)).length};
  if(/^(New York|Washington)$/i.test(raw)) return {kind:'unresolved',reason:'city_or_state_ambiguous'};
  const states=segments.map(stateOnly);
  if(states.some(Boolean)&&states.every((s,i)=>s||/^(?:United States Remote Office|Remote(?:\s*[-,]\s*)?(?:US|USA|United States)?)$/i.test(segments[i]))) {
    // A state-specific remote office supplies a residence restriction, not
    // nationwide eligibility. Narrower unresolved title territories need review.
    if(suffix!==title && !resolveUsStateCode(suffix)) return {kind:'unresolved',reason:'substate_territory_needs_review'};
    return {kind:'territory',states:[...new Set(states.filter(Boolean))],reason:'explicit_state_scope'};
  }
  // Existing validated city points remain usable; unresolved evidence with
  // stale coordinates never qualifies. Multi-location evidence keeps all points.
  if(old?.status==='validated' && clean(old.source_location)===raw && validPoint({lat:job.job_lat,lng:job.job_lng,state:job.state}) && !stateOnly(raw) && !/^remote\b/i.test(raw)) return {kind:'local',reason:'validated_source_point'};
  return {kind:'unresolved',reason:/remote|home|field|territor/i.test(raw)?'arrangement_or_unspecified_territory':/^united states(?: of america)?$|^USA?$/i.test(raw)?'country_only':'unparsed_source_location'};
}
async function resolveLocation(job, geocode) {
  const scope=classifyLocation(job);
  const evidence={...job.location_evidence,source_country_code:['local','territory'].includes(scope.kind)?'US':job.location_evidence?.source_country_code,version:VERSION,source_location:clean(job.location_raw),source_title:clean(job.title_original),checked_at:new Date().toISOString(),scope};
  if(scope.kind==='local'&&scope.queries?.length) {
    const locations=[];
    for(const q of scope.queries) {
      let p;try{p=await geocode(q.query,{sourceCountryCode:'US'});}catch{}
      if(validPoint(p)&&resolveUsStateCode(p.state)===q.state)locations.push({...p,state:q.state,location:q.query});
    }
    if(locations.length===scope.queries.length) return {job_lat:locations[0].lat,job_lng:locations[0].lng,state:locations[0].state,location_evidence:{...evidence,status:'validated',locations,geocoded_location:locations.map(p=>p.location).join(' | ')}};
    return {job_lat:null,job_lng:null,state:null,location_evidence:{...evidence,status:'unresolved',scope:{...scope,kind:'unresolved',reason:'geocode_failed',requested_scope:scope}}};
  }
  if(scope.kind==='local')return {job_lat:job.job_lat,job_lng:job.job_lng,state:job.state,location_evidence:evidence};
  return {job_lat:null,job_lng:null,state:null,location_evidence:{...evidence,status:scope.kind==='foreign'?'foreign':scope.kind==='unresolved'?'unresolved':'validated'}};
}
module.exports={VERSION,classifyLocation,resolveLocation,cityQuery,stateOnly,validPoint};
