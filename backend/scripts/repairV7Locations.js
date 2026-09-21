// Standalone reviewed-data repair. Never imported by server startup or rank().
// Defaults to read-only verification. --apply is the explicit write boundary.
const crypto=require('crypto');
const hash=s=>crypto.createHash('md5').update(String(s||'')).digest('hex');
async function repairV7Locations(db,entries,{apply=false,rollback=false}={}) {
  const counts={ready:0,updated:0,skipped:0};let cursor=0;
  async function worker(){while(cursor<entries.length){const r=entries[cursor++];
    const expected=rollback?r.patch:r.original,patch=rollback?r.original:r.patch;
    if(!/^[a-f0-9-]{36}$/.test(r.id)||Object.keys(patch).some(k=>!['job_lat','job_lng','state','location_evidence'].includes(k)))throw Error('Invalid repair plan');
    let sourceUpdatedAt;
    if(r.patch.location_evidence.source_description_hash && !rollback){
      const current=await db.from('jobs').select('description_text,updated_at').eq('id',r.id).maybeSingle();
      if(current.error)throw current.error;
      if(!current.data||hash(current.data.description_text)!==r.patch.location_evidence.source_description_hash){counts.skipped++;continue;}
      sourceUpdatedAt=current.data.updated_at;
    }
    let q=db.from('jobs');q=apply?q.update(patch):q.select('id');
    q=q.eq('id',r.id).eq('status','active').eq('moderation_status','approved').eq('location_raw',r.location_raw).eq('title_original',r.title_original);
    if(sourceUpdatedAt)q=q.eq('updated_at',sourceUpdatedAt);
    for(const k of ['job_lat','job_lng','state','location_evidence'])q=expected[k]==null?q.is(k,null):q.eq(k,typeof expected[k]==='object'?JSON.stringify(expected[k]):expected[k]);
    const result=await (apply?q.select('id'):q);if(result.error)throw new Error(`Location repair failed: ${result.error.message}`);
    if(result.data?.length){counts.ready++;if(apply)counts.updated++;}else counts.skipped++;
  }}
  await Promise.all(Array.from({length:6},worker));return counts;
}
if(require.main===module){
  require('dotenv').config();const fs=require('fs');const at=process.argv.indexOf('--plan');
  if(at<0||!process.argv[at+1])throw Error('Supply --plan /path/to/reviewed-plan.json; default is read-only');
  const entries=JSON.parse(fs.readFileSync(process.argv[at+1],'utf8'));
  const {createClient}=require('@supabase/supabase-js');if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error('Database configuration required');
  repairV7Locations(createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY),entries,{apply:process.argv.includes('--apply'),rollback:process.argv.includes('--rollback')}).then(console.log).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={repairV7Locations};
