// Actual Express handlers with an in-memory database and verified-token fake.
// No production users, messages, subscriptions, or database writes.
const assert=require('node:assert/strict');const express=require('express');
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_ANON_KEY='test';process.env.SUPABASE_SERVICE_ROLE_KEY='server';
let profile=null;
const job={id:'11111111-1111-4111-8111-111111111111',title_original:'Unique Specialty Manager BrandXYZ',company_name:'HiddenEmployer',source_job_id:'secret-requisition',description_text:'BrandXYZ secret description',source_url:'https://secret.example/job',application_url:'https://secret.example/apply',city:'Boston',state:'MA',location_raw:'Boston, MA, United States',job_lat:42.36,job_lng:-71.06,status:'active',moderation_status:'approved',ai_analysis:{product_categories:['Medical Device']},category:'Account Management'};
const row={job_id:job.id,candidate_id:'candidate',scored_at:'2026-09-01',overall_score:90,preference_fit:100,candidate_fit:80,recommendation:'Strong Match',saved:true,jobs:job};
const records={jobs:[job],candidate_job_matches:[row],applications:[],employers:[]};
class Query{
 constructor(table){this.table=table;this.filters=[];this.singleResult=false;}
 select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}neq(k,v){this.filters.push(r=>r[k]!==v);return this;}
 order(){return this;}range(){return this;}limit(){return this;}or(){return this;}in(){return this;}not(){return this;}gte(){return this;}lte(){return this;}ilike(){return this;}
 maybeSingle(){this.singleResult=true;return this;}single(){this.singleResult=true;return this;}
 upsert(p){this.write=p;return this;}
 then(resolve,reject){let values=this.table==='candidate_profiles'?(profile?[profile]:[]):records[this.table]||[];
 if(this.write){profile={...profile,...this.write};values=[profile];}else values=values.filter(r=>this.filters.every(f=>f(r)));
 return Promise.resolve({data:this.singleResult?values[0]||null:values,count:values.length,error:null}).then(resolve,reject);}
}
const db={from:t=>new Query(t),auth:{getUser:async token=>({data:{user:token==='valid'?{id:'user'}:null}})}};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./scoring/precompute')]={exports:{fetchActiveJobs:async()=>[job],scoreAndStoreForCandidate:async()=>({scoredCount:0})}};
const originalInterval=global.setInterval;global.setInterval=(...a)=>originalInterval(...a).unref();
const app=express();app.use(express.json());app.use('/api',require('./routes/jobs'));app.use('/api',require('./routes/applications'));app.use('/api',require('./routes/profile'));app.use('/api',require('./routes/careerIntelligence'));app.use('/api',require('./routes/applicationPackage'));app.use('/',require('./routes/publicPages'));
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const call=(url,auth=true,method='GET',body)=>fetch(origin+url,{method,headers:{...(auth?{Authorization:'Bearer valid'}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const noSecrets=data=>assert(!/HiddenEmployer|BrandXYZ|secret-requisition|secret\.example|Unique Specialty|Boston/.test(typeof data==='string'?data:JSON.stringify(data)));
 try{
  for(const [state,status,end] of [['pretrial',null],['returning',null],['abandoned','incomplete'],['canceled','cancelled'],['expired','trialing','2020-01-01'],['missing-profile',null]]){
   profile=state==='missing-profile'?null:{id:'candidate',user_id:'user',subscription_status:status,trial_ends_at:end};
   for(const [url,method] of [['/api/job-search','GET'],['/api/career-intelligence','GET'],['/api/application-package/'+job.id,'GET'],['/api/jobs/'+job.id,'GET'],['/api/saved-jobs','GET'],['/api/jobs/'+job.id+'/save','POST'],['/api/jobs/'+job.id+'/apply','POST']]){
    const r=await call(url,true,method);assert.equal(r.status,403,state+' '+url);noSecrets(await r.json());
   }
   const apps=await call('/api/applications');assert.equal(apps.status,state==='missing-profile'?404:403);noSecrets(await apps.json());
   const keyword=await call('/api/jobs?keyword=HiddenEmployer');assert.equal(keyword.status,403);
  }
  const anonymous=await call('/api/jobs/'+job.id,false);assert.equal(anonymous.status,200);noSecrets(await anonymous.json());
  profile=null;const missing=await call('/api/jobs');assert.equal(missing.status,200);noSecrets(await missing.json());
  for(const path of ['/jobs','/jobs/'+job.id]){const r=await call(path,false);assert.equal(r.status,200);const html=await r.text();if(path==='/jobs') noSecrets(html);else {assert(!/HiddenEmployer|BrandXYZ|secret-requisition|secret\.example|Unique Specialty/.test(html));assert(html.includes('Boston, MA'));assert(html.includes('Specialty Manager'));}}
  for(const state of ['trialing','active']){
   profile={id:'candidate',user_id:'user',subscription_status:state,trial_ends_at:'2099-01-01'};
   const r=await call('/api/jobs/'+job.id);assert.equal(r.status,200);const full=await r.json();assert.equal(full.company_name,job.company_name);assert.equal(full.title_original,job.title_original);assert.equal(full.source_url,job.source_url);
   assert.equal((await call('/api/job-search')).status,200);assert.equal((await call('/api/saved-jobs')).status,200);
  }
  profile={id:'candidate',user_id:'user',subscription_status:null};
  const forged=await call('/api/profile',true,'PUT',{name:'Candidate',subscription_status:'active',trial_ends_at:'2099-01-01',stripe_customer_id:'forged',id:'other'});assert.equal(forged.status,200);assert.equal(profile.subscription_status,null);assert.equal(profile.id,'candidate');assert.equal(profile.name,'Candidate');assert.equal((await call('/api/job-search')).status,403);
  console.log('PASS actual routes: anonymous, missing profile, pretrial, returning, abandoned, canceled, expired, trialing and active; details, search, saved, apply, applications, public HTML/metadata, keyword oracle and profile escalation.');
 }finally{server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1;});
