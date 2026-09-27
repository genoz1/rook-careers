const assert=require('node:assert/strict');const express=require('express');
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='server';
const jobs=[
 {id:'a',title_original:'Exact Device Title',company_name:'Device Employer',source_url:'https://secret.example/a',ai_analysis:{product_categories:['Medical Device']},match:{overall_score:80}},
 {id:'b',title_original:'Exact Diagnostics Title',company_name:'Diagnostics Employer',source_url:'https://secret.example/b',ai_analysis:{product_categories:['Diagnostics']},match:{overall_score:75}},
 {id:'c',title_original:'Exact Veterinary Title',company_name:'Veterinary Employer',source_url:'https://secret.example/c',ai_analysis:{product_categories:['Veterinary']},match:{overall_score:70}}
];
const tables={onboarding_v7_sessions:[],candidate_profiles:[]};
class Query{
 constructor(name){this.name=name;this.filters=[];this.value=null;this.one=false;}
 select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}
 gt(k,v){this.filters.push(r=>r[k]>v);return this;}
 is(k,v){this.filters.push(r=>(r[k]??null)===v);return this;}
 maybeSingle(){this.one=true;return this;}
 insert(value){this.value={insert:value};return this;}
 update(value){this.value={update:value};return this;}
 upsert(value){this.value={upsert:value};return this;}
 then(resolve){let arr=tables[this.name],rows=arr.filter(r=>this.filters.every(f=>f(r)));
 if(this.value?.insert){arr.push({...this.value.insert,created_at:new Date().toISOString()});rows=[];}
 if(this.value?.update)rows.forEach(r=>Object.assign(r,this.value.update));
 if(this.value?.upsert){assert(!('onboarding_version'in this.value.upsert));arr.push(this.value.upsert);rows=[];}
 return Promise.resolve({data:this.one?rows[0]||null:rows,error:null}).then(resolve);}
}
const db={from:name=>new Query(name),auth:{getUser:async token=>({data:{user:token==='valid'?{id:'user',email_confirmed_at:'yes'}:null}})}};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./v7Matching')]={exports:{rank:async()=>jobs}};
const app=express();app.use(express.json());app.use('/api/v8',require('./routes/onboardingV8'));
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const root=`http://127.0.0.1:${server.address().port}/api/v8`;
 try{
  const call=async(path,method='GET',body,token='',auth=false)=>{const r=await fetch(root+path,{method,headers:{'Content-Type':'application/json','X-ROOK-V7':token,...(auth?{Authorization:'Bearer valid'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  const entry=await call('/session','POST',{industry:'Diagnostics',location:{lat:28.9,lng:-82,city:'Oxford',state:'Florida',stateAbbr:'FL',zip:'34484',label:'Oxford, FL'}});
  assert.equal(entry.status,200);const token=entry.data.token;
  let page=await call('/session?initial=1','GET',null,token);assert.equal(page.status,200);assert.equal(page.data.count,3);
  assert.equal(page.data.jobs[0].company_name,'Diagnostics Employer');assert.equal(page.data.jobs[1].company_name,'Device Employer');
  const locked=JSON.stringify(page.data.jobs[2]);for(const secret of ['Veterinary Employer','Exact Veterinary Title','https://secret.example/c'])assert(!locked.includes(secret));
  assert.equal((await call('/session','GET',null,'deadbeef')).status,410);
  assert.equal((await call('/preference','PUT',{industry:'Veterinary'},token)).status,200);
  page=await call('/session','GET',null,token);assert.equal(page.data.count,3);assert.equal(page.data.jobs[0].company_name,'Veterinary Employer');
  assert.equal((await call('/claim','POST',null,token,true)).status,200);assert.equal(tables.candidate_profiles.length,1);
  tables.candidate_profiles[0].subscription_status='trialing';tables.candidate_profiles[0].trial_ends_at='2099-01-01T00:00:00Z';
  assert.equal((await call('/session','GET',null,token)).status,403);
  page=await call('/session','GET',null,token,true);assert.equal(page.data.unlocked,true);assert(page.data.jobs.every(j=>j.company_name));
  console.log('PASS V8 route: session, first-two reveal, locked sanitization, industry rerank, ownership, account claim and authorized unlock.');
 }finally{server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1});
