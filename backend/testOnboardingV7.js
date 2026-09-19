const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {preview,answersToProfile}=require('./v7Preview');
const root=path.resolve(__dirname,'..');
const secretJob={id:'real-job-1',company_name:'ACME Corporation',recruiter_company:'SECRET Agency',recruiter_name:'SECRET Person',source_type:'hidden-source',source_job_id:'hidden-source-id',employer_id:'hidden-employer',source_url:'https://secret.example/apply',application_url:'https://secret.example/apply',description_html:'SECRET HTML',description_text:'SECRET text',ai_analysis:{source:'SECRET analysis',product_categories:['Medical Device']},title_original:'Sales Manager at ACME https://secret.example/apply',city:'Boston',state:'MA',location_raw:'Boston, MA, United States',date_posted:'2026-09-16',job_lat:42,job_lng:-71,distance_miles:4,match:{overall_score:84,preference_fit:84,candidate_fit:null,reasons:['SECRET reason'],concerns:['SECRET concern'],categories:{company:'SECRET'},recommendation:'Apply'}};
const answer={location:{lat:42,lng:-71,city:'Boston',state:'MA',label:'Boston, MA'},industry:'Medical Device',years:5.5,territories:['local','regional']};
assert.equal(answersToProfile(answer).total_sales_years,5.5);
assert.doesNotThrow(()=>answersToProfile({...answer,industry:'Breaking In'}));
assert.throws(()=>answersToProfile({...answer,location:{lat:'42',lng:-71}}));
assert.throws(()=>answersToProfile({...answer,territories:['forged']}));
const masked=preview(secretJob,0);
assert(!/SECRET|ACME|real-job|hidden-source|hidden-employer/i.test(JSON.stringify(masked)));
assert.equal(masked.match.overall_score,84);
for(const file of ['rook-onboarding-v7.html','rook-onboarding-v7-signup.html','rook-dashboard-v7.html','rook-checkout-v7.html']) {
  const html=fs.readFileSync(path.join(root,'public',file),'utf8');
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if(m[1].trim()) new vm.Script(m[1],{filename:file});
}
for(const file of ['rook-v7.js']) new vm.Script(fs.readFileSync(path.join(root,'public',file),'utf8'));
for(const file of ['public/rook-onboarding-v6.html','public/rook-onboarding-v6-signup.html','public/rook-checkout.html','backend/routes/stripe.js','backend/matching.js']) {
  assert.equal(fs.readFileSync(path.join(root,file),'utf8'),execFileSync('git',['show',`HEAD:${file}`],{cwd:root,encoding:'utf8'}),`${file} changed`);
}
const questions=fs.readFileSync(path.join(root,'public/rook-onboarding-v7.html'),'utf8');
assert(!questions.includes('s-matches-preview'));
assert(!questions.includes('btnCreateAccount'));
assert(questions.includes("window.location.href = 'rook-dashboard-v7.html'"));
const checkout=fs.readFileSync(path.join(root,'public/rook-checkout-v7.html'),'utf8');
assert(checkout.includes("'rook-dashboard-v7.html?trial=started'"));
assert(checkout.includes('stripe.confirmCardSetup'));
assert(checkout.includes('/api/stripe/create-subscription-from-setup'));
// Stateful external-service fake: exercise actual Express V7 routes without
// creating users, charging cards, uploading real résumés or touching production.
const tables={onboarding_v7_sessions:[],candidate_profiles:[]};
const files=new Map();
const users={a:{id:'user-a',email_confirmed_at:'today',user_metadata:{first_name:'Test',last_name:'User'}},b:{id:'user-b',email_confirmed_at:'today'},unverified:{id:'user-c'}};
class Query {
 constructor(name){this.name=name;this.filters=[];this.kind='select';}
 select(){return this;} eq(k,v){this.filters.push(r=>r[k]===v);return this;} is(k,v){this.filters.push(r=>(r[k]??null)===v);return this;}
 gt(k,v){this.filters.push(r=>r[k]>v);return this;} lt(k,v){this.filters.push(r=>r[k]<v);return this;} limit(){return this;}
 insert(data){this.kind='insert';this.payload=data;return this;} update(data){this.kind='update';this.payload=data;return this;}
 upsert(data){this.kind='upsert';this.payload=data;return this;} delete(){this.kind='delete';return this;}
 maybeSingle(){this.single=true;return this;}
 then(resolve,reject){return Promise.resolve().then(()=>{
  const rows=tables[this.name];let matches=rows.filter(r=>this.filters.every(f=>f(r)));
  if(this.kind==='insert'){rows.push({...this.payload});matches=[rows.at(-1)];}
  if(this.kind==='upsert'){let row=rows.find(r=>r.user_id===this.payload.user_id);if(!row){row={};rows.push(row);}Object.assign(row,this.payload);matches=[row];}
  if(this.kind==='update') for(const row of matches) Object.assign(row,this.payload);
  if(this.kind==='delete') tables[this.name]=rows.filter(r=>!matches.includes(r));
  return {data:structuredClone(this.single ? matches[0] || null : matches),error:null};
 }).then(resolve,reject);}
}
const db={from:name=>new Query(name),auth:{getUser:async token=>({data:{user:users[token]},error:null})},storage:{from:()=>({
 upload:async(p,b)=>{files.set(p,Buffer.from(b));return {error:null};},
 download:async p=>({data:new Blob([files.get(p)]),error:null}),
 remove:async paths=>{paths.forEach(p=>files.delete(p));return {error:null};}
})}};
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fake';
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./v7Matching')]={exports:{rank:async()=>[structuredClone(secretJob),{...structuredClone(secretJob),id:'real-job-2'}]}};
const express=require('express');const app=express();app.use(express.json());app.use('/api/v7',require('./routes/onboardingV7'));
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 let capability;
 async function call(url,method='GET',who,body){return fetch(base+'/api/v7'+url,{method,headers:{...(capability?{'X-ROOK-V7':capability}:{}),...(who?{Authorization:`Bearer ${who}`} : {}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});}
 try {
  let r=await call('/session','POST',null,answer);assert.equal(r.status,200);capability=(await r.json()).token;
  r=await call('/session');assert.equal(r.headers.get('cache-control'),'private, no-store');let data=await r.json();assert.equal(data.jobs.length,2);assert.equal(data.unlocked,false);assert(!/SECRET|ACME|real-job|secret.example/i.test(JSON.stringify(data.jobs)));
  assert(Date.parse(tables.onboarding_v7_sessions[0].expires_at)>Date.now()+29*24*60*60*1000,'opened matches remain recoverable beyond 24 hours');
  const renewedExpiry=tables.onboarding_v7_sessions[0].expires_at;
  await call('/session');assert.equal(tables.onboarding_v7_sessions[0].expires_at,renewedExpiry,'reads do not repeatedly write expiry');
  const fd=new FormData();fd.append('resume',new Blob(['private resume bytes'],{type:'application/pdf'}),'resume.pdf');
  r=await call('/resume','POST',null,fd);assert.equal(r.status,200);assert.equal(files.size,1);
  r=await call('/session');data=await r.json();assert.equal(data.profile.resume_file_path,'pending');
  assert.equal((await call('/resume')).status,403);
  assert.equal((await call('/claim','POST','unverified')).status,401);
  assert.equal((await call('/claim','POST','a')).status,200);
  assert.equal((await call('/claim','POST','a')).status,200);
  assert.equal((await call('/claim','POST','b')).status,403);
  assert.equal((await call('/session','GET','b')).status,403);
  assert.deepEqual(tables.candidate_profiles[0].territory_size_preferences,['local','regional']);
  assert.equal(tables.candidate_profiles[0].name,'Test User');
  r=await call('/resume','GET','a');assert.equal(await r.text(),'private resume bytes');
  assert.equal((await call('/resume-complete','POST','a')).status,409);
  tables.candidate_profiles[0].resume_file_path='user-a/processed.pdf';
  assert.equal((await call('/resume-complete','POST','a')).status,200);assert.equal(files.size,0);
  r=await call('/session?trial=started','GET','a');data=await r.json();assert.equal(data.unlocked,false);
  tables.candidate_profiles[0].subscription_status='trialing';tables.candidate_profiles[0].trial_ends_at=new Date(Date.now()+86400000).toISOString();
  r=await call('/session','GET','a');data=await r.json();assert.equal(data.unlocked,true);assert.deepEqual(data.jobs.map(j=>j.id),['real-job-1','real-job-2']);assert.equal(data.jobs[0].match.overall_score,84);
  tables.candidate_profiles[0].trial_ends_at='2000-01-01';
  r=await call('/session','GET','a');data=await r.json();assert.equal(data.unlocked,false);assert(!/SECRET|ACME|real-job/.test(JSON.stringify(data.jobs)));
  tables.onboarding_v7_sessions[0].expires_at='2000-01-01';assert.equal((await call('/session','GET','a')).status,410);
  console.log('PASS V7: answer validation, server redaction, private résumé staging/ownership, idempotent claim, profile transfer, entitlement checks, frozen results, expiry, script syntax, and V6 byte preservation.');
 } finally {server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1;});
