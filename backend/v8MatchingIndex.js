// Per-process, revision-checked V8 inventory. No job details or user data.
const {performance}=require('node:perf_hooks');
const {classifyLocation,LOCAL_MATCHING_SCOPE}=require('./jobLocationScope');
const {hydrateDescriptionTerritories}=require('./v7Matching');
const FIELDS='id,source_type,title_original,title_normalized,location_raw,location_evidence,job_lat,job_lng,state,employment_type,remote_status,territory,date_posted,first_seen_at,salary_min,salary_max,compensation_text';
const AI_FIELDS=['product_categories','market_industries','required_customer_types','required_industries','preferred_industries','seniority_level','sales_motion','required_years_experience','specialty_requirements','clinical_requirements'];
const pick=(obj,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(obj,k)).map(k=>[k,obj[k]]));
function compact(job) {
  const row=pick(job,FIELDS.split(','));
  if(job.location_evidence){
    row.location_evidence=pick(job.location_evidence,['version','status','source_country_code','source_location','source_title']);
    if(job.location_evidence.scope)row.location_evidence.scope={reason:job.location_evidence.scope.reason};
    if(Array.isArray(job.location_evidence.locations))row.location_evidence.locations=job.location_evidence.locations.map(p=>pick(p,['lat','lng','state']));
  }
  // Compute the EXISTING classification while its required source description
  // is available; retain only the derived scope, never the full description.
  row[LOCAL_MATCHING_SCOPE]=classifyLocation(job);
  if(job.ai_analysis!=null)row.ai_analysis=pick(job.ai_analysis,AI_FIELDS);
  return row;
}
function createIndex(db,{readPages,intervalMs=30000}={}) {
  let snapshot=null,pending=null,timer=null;
  async function revision() {
    const {data,error}=await db.from('v8_matching_revision').select('revision').eq('id',1).single();
    if(error||!data||!/^[0-9]+$/.test(String(data.revision)))throw Error('Matching revision unavailable');
    return String(data.revision);
  }
  async function rebuild() {
    const before=await revision();
    if(snapshot?.revision===before)return snapshot;
    const timing={candidate_page_reads:0};
    const rows=await readPages(db,FIELDS+',ai_analysis,extraction_evidence',timing);
    const hydrated=await hydrateDescriptionTerritories(db,rows);
    const jobs=hydrated.map(compact);
    if(await revision()!==before)throw Error('Inventory changed during index rebuild');
    snapshot={revision:before,jobs,builtAt:Date.now()};
    console.info('V8_INDEX_READY',JSON.stringify({revision:before,rows:jobs.length,bytes:Buffer.byteLength(JSON.stringify(jobs))}));
    return snapshot;
  }
  function refresh() {
    if(!pending)pending=rebuild().finally(()=>{pending=null;});
    return pending;
  }
  async function current(timing={}) {
    const start=performance.now();
    try {
      // Initial POST validates this version atomically in its necessary
      // session write. It needs no separate per-search freshness request.
      if(timing.validate_with_session && snapshot){
        timing.index_revision=snapshot.revision;timing.local_index=1;return snapshot.jobs;
      }
      const version=await revision();
      timing.index_revision=version;
      if(snapshot?.revision===version){timing.local_index=1;return snapshot.jobs;}
      timing.index_missing=snapshot?0:1;timing.index_stale=snapshot?1:0;
    } catch {timing.index_check_failed=1;}
    finally {timing.index_check_ms=performance.now()-start;}
    timing.local_index=0;timing.database_fallback=1;
    // Recovery is independent of the visitor and cannot hold up fallback.
    refresh().catch(()=>{});
    return null;
  }
  function start() {
    if(timer)return;
    refresh().catch(()=>console.warn('V8_INDEX_UNAVAILABLE; authoritative fallback enabled'));
    timer=setInterval(()=>refresh().catch(()=>{}),intervalMs);timer.unref();
  }
  return {current,refresh,start,stop(){clearInterval(timer);timer=null;}};
}
module.exports={createIndex,compact,FIELDS,AI_FIELDS};
