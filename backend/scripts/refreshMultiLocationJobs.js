// Dry run by default. Revalidate active multi-location listings during rollout.
require('dotenv').config();
const {createClient}=require('@supabase/supabase-js');
const {validateJobLocation}=require('../validateJobLocation');
(async()=>{
  const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
  const apply=process.argv.includes('--apply');
  let changed=0;
  for(let offset=0;;offset+=100){
    const {data,error}=await db.from('jobs').select('id,location_raw,location_evidence,job_lat,job_lng,state').eq('status','active').ilike('location_raw','%|%').order('id').range(offset,offset+99);
    if(error)throw error;
    for(const job of data||[]){
      const updated=await validateJobLocation(job,undefined,job);
      if(JSON.stringify(updated.location_evidence)===JSON.stringify(job.location_evidence))continue;
      changed++;
      if(apply){const {error}=await db.from('jobs').update(updated).eq('id',job.id).eq('location_raw',job.location_raw);if(error)throw error;}
    }
    if(!data||data.length<100)break;
  }
  console.log(JSON.stringify({mode:apply?'applied':'dry-run',changed}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
