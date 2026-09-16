const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {createRequire} = require('node:module');
const {scoreJob} = require('./matching');
const {prepareJob,repairSnapshot} = require('./v7Location');
const {preview} = require('./v7Preview');
const profile = {home_lat:39.5268,home_lng:-119.8113,home_city:'Reno',home_state:'Nevada',home_zip:'89501',home_location_label:'Reno, NV',work_style:'field',total_sales_years:10,desired_industries:['Diagnostics'],territory_size_preference:'local',territory_size_preferences:['local']};
// Observed live 2026-09-16. Only scoring/location fields are retained; all
// omitted structured job fields were null. No account or resume data.
const records = [
 {id:'63724fb2-81d0-43fd-98dd-caa5801fbb67',title_original:'Account Executive - MI Clarity - California South',location_raw:'Remote - California',city:null,state:'California',job_lat:36.7014631,job_lng:-118.755997,remote_status:null,ai_analysis:{product_categories:['Molecular Diagnostics','Oncology Diagnostics','AI-powered prognostic assay']},expected:85},
 {id:'71de503a-b701-472a-96b3-6f44cea7c6c0',title_original:'Regional Account Executive - General Pediatrics (Long Island & Queens)',location_raw:'Remote',city:null,state:'OR',job_lat:43.0059455,job_lng:-123.8925908,remote_status:null,ai_analysis:{product_categories:['Genetic Testing','Diagnostics']},expected:75},
 {id:'acede788-9577-42ed-af39-95475a89f761',title_original:'Sales Development Representative',location_raw:'Leiden',city:null,state:'NV',job_lat:39.6503817,job_lng:-119.87382,remote_status:null,employment_type:'FullTime',ai_analysis:{product_categories:['Healthcare SaaS','EHR/EPD software']},expected:80}
];
const control = {...records[0],id:'nearby-control',title_original:'Account Executive',company_name:'Hidden Employer',source_url:'https://hidden.example/job',location_raw:'Reno, NV',city:'Reno',state:'NV',job_lat:39.54,job_lng:-119.82};
function queryDb(rows) {const q={from(){return q;},select(){return q;},eq(){return q;},or(){return q;},gte(){return q;},lte(){return q;},limit(){return Promise.resolve({data:rows,error:null});}};return q;}
(async () => {
  // GitHub baseline; this workspace's original local commit has the same tree.
  let baseline='b4c6f86fe141698f26931f02dc685b6acc144f29';
  try {execFileSync('git',['cat-file','-e',baseline],{stdio:'ignore'});} catch {baseline='320ce7a';}
  // Replay the pre-repair V7 path and V6's unchanged scoreJob using identical
  // live record inputs: the bad scores reproduce in BOTH, not a new formula.
  const oldModule = {exports:{}};
  vm.runInNewContext(execFileSync('git',['show',`${baseline}:backend/v7Matching.js`],{encoding:'utf8'}),{module:oldModule,require:createRequire(__filename)});
  const before = await oldModule.exports.rank(queryDb(records),profile);
  for (const r of records) {
    assert.equal(scoreJob(r,profile).overall_score,r.expected);
    assert.equal(before.find(j=>j.id===r.id).match.overall_score,r.expected);
    assert.equal(prepareJob(r,profile),null);
  }
  assert.equal(prepareJob({...records[2],id:'different-import'},profile),null);
  assert.equal(prepareJob({...control,location_raw:'Leiden, NV'},profile).id,control.id);
  assert.equal(prepareJob({...control,location_raw:'Leiden, Netherlands'},profile),null);
  assert.equal(prepareJob({...control,location_raw:'New York, NY',state:'NY',job_lat:40.71,job_lng:-74,remote_status:'remote'},profile),null);
  const broad = {...profile,territory_size_preferences:['national']};
  const usRemote = {...records[1],location_raw:'Remote, US'};
  assert.equal(prepareJob(usRemote,profile),null);
  assert.equal(prepareJob(usRemote,broad),null);
  assert.equal(prepareJob({...control,job_lat:40.71,job_lng:-74,remote_status:'remote'},broad),null);
  const stateWide = {...records[0],location_raw:'Remote - Nevada',state:'Nevada'};
  assert.equal(prepareJob(stateWide,profile),null);
  for(const location_raw of ['US CA Home Office','CA, United States','Remote - CA','California','United States Remote Office | California, USA']) assert.equal(prepareJob({...records[0],location_raw},profile),null);
  assert.equal(prepareJob({...control,job_lng:null},profile),null);
  const snapshot = [...records,control].map(j=>({...j,match:scoreJob(j,profile),distance_miles:123}));
  const untouched = structuredClone(snapshot);
  const repaired = repairSnapshot(snapshot,profile);
  assert.deepEqual(repaired.map(j=>j.id),[control.id]);
  assert.deepEqual(repaired[0].match,scoreJob(control,profile));
  assert.deepEqual(snapshot,untouched);
  assert.deepEqual(repairSnapshot(repaired,profile),repaired);
  assert(!/Hidden Employer|hidden\.example|nearby-control/.test(JSON.stringify(repaired.map(preview))));
  const pool=queryDb([...records,control]); let cap;pool.limit=n=>{cap=n;return Promise.resolve({data:[...records,control],error:null});};
  const ranked = await require('./v7Matching').rank(pool,profile);
  assert.equal(cap,400);
  const matchingSource=fs.readFileSync(require.resolve('./v7Matching'),'utf8');
  assert(!matchingSource.includes('job_lat.is.null'));
  assert(!matchingSource.includes('remote_status.eq.remote'));
  assert.deepEqual(ranked.map(j=>j.id),[control.id]);
  assert.deepEqual(ranked[0].match,scoreJob(control,profile));

  // Exercise actual GET /session handler in memory: old snapshots repaired
  // BEFORE serialization on either side of the unchanged entitlement gate.
  const s = {profile,jobs:snapshot,user_id:'owner'};
  let paid = false; let rankedLocation; let accountLocation={};
  const db = {auth:{getUser:async token=>({data:{user:{id:token,email_confirmed_at:'yes'}}})},from(name){let payload;const q={select(){return q;},eq(){return q;},is(){return q;},gt(){return q;},update(v){payload=v;return q;},maybeSingle:async()=>{if(payload)Object.assign(s,payload);return {data:name==='onboarding_v7_sessions'?s:{...accountLocation,subscription_status:paid?'active':'inactive'}};},then(resolve){if(payload)Object.assign(accountLocation,payload);return Promise.resolve({error:null}).then(resolve);}};return q;}};
  const routeModule={exports:{}};
  const routeRequire=createRequire(require.resolve('./routes/onboardingV7'));
  vm.runInNewContext(fs.readFileSync(require.resolve('./routes/onboardingV7'),'utf8'),{module:routeModule,require:n=>n==='@supabase/supabase-js'?{createClient:()=>db}:n==='../v7Matching'?{rank:async(db,p)=>{rankedLocation=p;return [{...control,id:'new-location-job'}];}}:routeRequire(n),process:{env:{SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'fake'}},setInterval:()=>({unref(){}}),Buffer});
  const handler=routeModule.exports.stack.find(l=>l.route?.path==='/session'&&l.route.methods.get).route.stack[0].handle;
  async function get(who) {let code=200,body;const res={status(n){code=n;return res;},json(v){body=v;return res;}};await handler({get:n=>n==='X-ROOK-V7'?'a'.repeat(64):`Bearer ${who}`},res);return {code,body};}
  let result=await get('owner');assert.equal(result.code,200);assert.equal(result.body.unlocked,false);assert.equal(result.body.jobs.length,1);assert(!JSON.stringify(result.body.jobs).includes('hidden.example'));
  paid=true;result=await get('owner');assert.equal(result.body.unlocked,true);assert.deepEqual(Array.from(result.body.jobs,j=>j.id),[control.id]);
  assert.equal((await get('other-account')).code,403);
  const change=routeModule.exports.stack.find(l=>l.route?.path==='/location').route.stack[0].handle;
  async function move(who,body){let code=200;const res={status(n){code=n;return res;},json(){return res;}};await change({body,get:n=>n==='X-ROOK-V7'?'a'.repeat(64):`Bearer ${who}`},res);return code;}
  const newLocation={home_lat:42.36,home_lng:-71.06,home_city:'Boston',home_state:'MA',home_location_label:'Boston, MA',subscription_status:'active',desired_industries:['forged']};
  assert.equal(await move('other-account',newLocation),403);
  assert.equal(await move('owner',{...newLocation,home_lat:'invalid'}),400);
  assert.equal(await move('owner',newLocation),200);
  assert.equal(s.profile.home_city,'Boston');assert.equal(s.jobs[0].id,'new-location-job');
  assert.equal(rankedLocation.desired_industries[0],'Diagnostics');assert.equal(accountLocation.home_city,'Boston');
  assert.equal(accountLocation.subscription_status,undefined);
  s.user_id=null;assert.equal(await move('anonymous',{...newLocation,home_city:'Reno',home_lat:39.5268,home_lng:-119.8113}),200);

  for(const file of ['backend/matching.js','backend/geocoding.js','backend/jobEligibility.js','backend/routes/jobs.js','public/rook-onboarding-v6.html','public/rook-dashboard.html','public/rook-checkout.html']) assert.equal(fs.readFileSync(file,'utf8'),execFileSync('git',['show',`${baseline}:${file}`],{encoding:'utf8'}),`${file} changed`);
  console.log('PASS: live Reno V6/V7 scores reproduce at 85/75/80; bad locations excluded; valid scores preserved; old snapshots repaired before masked/unmasked responses; cross-account access denied; V6 and shared scorer unchanged.');
})().catch(e=>{console.error(e);process.exitCode=1;});
