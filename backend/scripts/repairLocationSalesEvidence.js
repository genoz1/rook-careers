// Targeted repair only: no ATS fetching, ingestion, analysis, or embeddings.
// Dry run by default. --apply writes only changed location evidence and
// closes titles newly excluded by the internal-sales-role rule.
require('dotenv').config();
const fs=require('fs');
const {createClient}=require('@supabase/supabase-js');
const {classifyLocation,resolveLocation}=require('../jobLocationScope');
const {geocodeLocation}=require('../geocoding');
const {isInternalSalesRole}=require('../relevanceFilter');
const signature=s=>JSON.stringify({kind:s?.kind,states:[...new Set([...(s?.states||[]),...(s?.queries||[]).map(q=>q.state)])].sort(),queries:(s?.queries||[]).map(q=>q.query).sort()});
function plan(job){
 if(isInternalSalesRole(job.title_original))return {action:'close_internal_role'};
 const input={...job,location_evidence:{...job.location_evidence,version:0,scope:undefined}};
 const next=classifyLocation(input),old=job.location_evidence?.scope;
 const evidence=job.location_evidence;
 // Keep existing validated city sets when the newly parsed cities are already
 // represented; reprocessing must not discard other valid territory points.
 if(old?.kind==='local'&&evidence.status==='validated'&&
    evidence.source_location===String(job.location_raw||'').trim().replace(/\s+/g,' ')&&
    next.kind==='local'&&next.queries?.length&&next.queries.every(q=>
      (evidence.locations||[]).some(p=>p.location===q.query&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.state===q.state)))return null;
 // Limit reprocessing to newly recognized actual cities, not every legacy row.
 if(next.kind==='local'&&next.queries?.length&&signature(next)!==signature(old))return {action:'repair_location',input,next};
 return null;
}
async function run(){
 const apply=process.argv.includes('--apply');
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
 const rows=[];
 for(let start=0;;start+=500){const {data,error}=await db.from('jobs').select('id,company_name,title_original,description_text,location_raw,location_evidence,extraction_evidence,source_type,job_lat,job_lng,state,status,social_eligible,updated_at').eq('status','active').order('id').range(start,start+499);if(error)throw error;rows.push(...data);if(data.length<500)break;}
 const candidates=rows.map(job=>({job,change:plan(job)})).filter(x=>x.change);
 console.log(JSON.stringify({mode:apply?'apply':'dry-run',scanned:rows.length,candidates:candidates.length,close:candidates.filter(x=>x.change.action==='close_internal_role').length,locations:candidates.filter(x=>x.change.action==='repair_location').length}));
 if(!apply){for(const {job,change}of candidates)console.log(JSON.stringify({id:job.id,company:job.company_name,title:job.title_original,raw:job.location_raw,action:change.action,next:change.next}));return;}
 const backup='/tmp/rook-location-sales-backup-'+Date.now()+'.json';fs.writeFileSync(backup,JSON.stringify(candidates.map(x=>x.job)));console.log('BACKUP '+backup);
 const cache=new Map();let changed=0,failed=0,conflicts=0;
 for(const {job,change}of candidates){
  let patch;
  if(change.action==='close_internal_role')patch={status:'closed',social_eligible:false};
  else{
   const resolved=await resolveLocation(change.input,async(q,opts)=>{
    if(!cache.has(q))cache.set(q,await geocodeLocation(q,opts));return cache.get(q);
   });
   if(resolved.location_evidence.status!=='validated'){failed++;console.log(JSON.stringify({id:job.id,result:'geocode_unresolved_no_write'}));continue;}
   patch=resolved;
  }
  let q=db.from('jobs').update(patch).eq('id',job.id).eq('status','active');
  q=job.updated_at?q.eq('updated_at',job.updated_at):q.is('updated_at',null);
  const {data,error}=await q.select('id');if(error)throw error;
  if(data.length)changed++;else conflicts++;
  console.log(JSON.stringify({id:job.id,result:data.length?'updated':'concurrent_change_skipped',action:change.action,lat:patch.job_lat,lng:patch.job_lng}));
 }
 console.log(JSON.stringify({changed,failed,conflicts,backup}));if(failed||conflicts)process.exitCode=2;
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={plan};
