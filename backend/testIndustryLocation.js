const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {classify,matches} = require('../public/rook-job-classification');
const {isUsEligibleJob} = require('./jobEligibility');
const {validateJobLocation} = require('./validateJobLocation');
const {rank} = require('./v7Matching');
const {preview} = require('./v7Preview');
const {scoreJob} = require('./matching');
const {readJobPool} = require('./jobPool');
const profile = {home_lat:41.7207, home_lng:-83.5694, desired_industries:['Veterinary'], total_sales_years:5.5, territory_size_preferences:['local']};
const vet = {id:'vet',title_original:'Veterinary District Sales Manager',location_raw:'USA-Ohio-Toledo',state:'OH',job_lat:41.6529143,job_lng:-83.5378173,ai_analysis:{product_categories:['Pet Food','Veterinary Nutrition'],required_customer_types:['Veterinary clinics']}};
const dual = {...vet,id:'dual',ai_analysis:{product_categories:['Diagnostics','Therapeutics'],required_customer_types:['Veterinary professionals']}};
const human = {...vet,id:'human',ai_analysis:{product_categories:['Cancer screening'],required_industries:['Veterinary/Animal Health'],preferred_industries:['Animal Health'],required_customer_types:['Oncologists','Hospitals']}};
function db(rows) {return {from(){const q={select(){return q},eq(){return q},gte(){return q},lte(){return q},order(){return q},or(){return q},range(a,b){return Promise.resolve({data:rows.slice(a,b+1),error:null})}};return q}};}
(async()=>{
  assert(matches(vet,['Veterinary']));
  assert(matches(dual,['Veterinary'])); assert(matches(dual,['Diagnostics']));
  assert(!matches(human,['Veterinary'])); assert(matches(human,['Diagnostics']));
  assert(!matches({...vet,ai_analysis:null},['Veterinary']));
  assert(!matches({...vet,ai_analysis:{product_categories:['Veterans Affairs software']}},['Veterinary']));
  for(const location_raw of ['Taipei','Warsaw']) assert(!isUsEligibleJob({...vet,location_raw,job_lat:40.2024077,job_lng:-83.0266448}));
  assert(isUsEligibleJob({...vet,location_raw:'Warsaw, IN',state:'IN'}));
  assert(isUsEligibleJob({...vet,location_raw:'Toledo',location_evidence:{source_country_code:'US'}}));
  assert(!isUsEligibleJob({...vet,location_evidence:{source_country_code:'TW'}}));
  let calls=0;const geo=async()=>{calls++;return {lat:vet.job_lat,lng:vet.job_lng,state:'OH'}};
  for(const job of [{...vet,location_raw:'Taipei'},{...vet,location_raw:'Warsaw',location_evidence:{source_country_code:'PL'}}]) {
    const result=await validateJobLocation(job,geo);assert.equal(result.job_lat,null);assert.equal(result.job_lng,null);
  }
  assert.equal(calls,0);
  const fresh=await validateJobLocation(vet,geo);assert.equal(fresh.location_evidence.status,'validated');assert(isUsEligibleJob({...vet,...fresh}));
  const reused=await validateJobLocation(vet,async()=>{throw Error('must not call lookup')},{...vet,...fresh});assert.equal(reused.job_lat,vet.job_lat);
  const failed=await validateJobLocation(vet,async()=>null);assert.equal(failed.job_lat,null);assert(isUsEligibleJob({...vet,...failed}));assert.equal(require('./v7Location').prepareJob({...vet,...failed},profile),null);
  const errored=await validateJobLocation(vet,async()=>{throw Error('offline')});assert.equal(errored.job_lat,null);
  const rows=Array.from({length:1101},(_,i)=>({...human,id:'human-'+i})).concat([vet,dual]);
  const pool=await readJobPool(db(rows).from('jobs'));assert.equal(pool.data.length,1103);
  let pages=0;const capped=db(Array.from({length:1500},(_,i)=>({...vet,id:'vet-'+i}))).from('jobs');const originalRange=capped.range;capped.range=(a,b)=>{pages++;return originalRange(a,b)};
  const bounded=await readJobPool(capped,{accept:()=>true,maxAccepted:400});assert.equal(bounded.data.length,400);assert.equal(pages,1);
  const prefilter=require('./industryPrefilter').industryPrefilter(['Veterinary']);assert(prefilter.includes('required_customer_types'));assert(!prefilter.includes('required_industries'));assert(!prefilter.includes('preferred_industries'));
  // A broad SQL prefilter must retain every positive market/customer example.
  const examples=['Diagnostics','Reference Laboratory','Point-of-Care Diagnostics','Clinical Laboratory','Pathology','Genetic Testing','Molecular Testing','Cancer Screening','NIPT','Medical Device','Capital Equipment','Surgical','DME','Imaging Equipment','Imaging Guided Therapy','Patient Monitoring','Consumables','Pharmaceutical','Pharma','Drug','Medication','Vaccine','Therapeutics','Therapies','Veterinary','Veterinarians','Vet','Animal Health','Healthcare SaaS','EHR','EPD','Clinical Information Systems','Dental','Distribution','Biotech','Life Sciences'];
  for(const value of examples) {
    const job={ai_analysis:{product_categories:[value]}};
    for(const label of classify(job).labels) {
      const clauses=require('./industryPrefilter').industryPrefilter([label]).split(',');
      assert(clauses.some(clause=>clause.startsWith('ai_analysis->>product_categories.')&&value.toLowerCase().includes(clause.split('%')[1])),`${label}: ${value} dropped by database prefilter`);
    }
  }
  const results=await rank(db(rows),profile);assert.deepEqual(results.map(j=>j.id).sort(),['dual','vet']);
  for(const result of results) assert.deepEqual(result.match,scoreJob(result,profile));
  const masked=preview(dual);assert(matches(masked,['Veterinary']));assert(matches(masked,['Diagnostics']));assert(!('location_evidence' in masked));
  // Browser V7 request must refresh the server pool, rather than discard checkbox query parameters.
  let request;const context={Response,URLSearchParams,window:{},location:{search:''},sessionStorage:{getItem:()=>''},fetch:async(path)=>{request=path;return new Response(JSON.stringify({profile,unlocked:false,jobs:[masked]}))}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/rook-v7.js','utf8'),context);
  vm.runInContext("rookV7Snapshot={profile:{},jobs:[]}; rookV7Auth=()=>({auth:{getSession:async()=>({data:{session:null}})}})",context);
  const response=await vm.runInContext("rookV7Fetch('/jobs?industries=Veterinary')",context);
  assert.equal(request,'/api/v7/session?industries=Veterinary');assert.equal((await response.json()).jobs.length,1);

  // Exercise the actual anonymous listing handler: a selected-market result
  // beyond the first 1,000 source rows must survive the display limit.
  const apiDb = {from(){const q={select(){return q},eq(){return q},order(){return q},or(){return q},range(a,b){return Promise.resolve({data:rows.slice(a,b+1),error:null})},then(resolve){return Promise.resolve({count:rows.length,error:null}).then(resolve)}};return q}};
  const routeModule={exports:{}};const routeRequire=createRequire(require.resolve('./routes/jobs'));
  vm.runInNewContext(fs.readFileSync(require.resolve('./routes/jobs'),'utf8'), {module:routeModule, require:n=>n==='@supabase/supabase-js'?{createClient:()=>apiDb}:routeRequire(n), process:{env:{SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}}, console, setTimeout,clearTimeout,setInterval:()=>({unref(){}}),URLSearchParams});
  const route=routeModule.exports.stack.find(l=>l.route?.path==='/jobs'&&l.route.methods.get).route.stack.at(-1).handle;
  let body;const res={status(){return res},json(v){body=v;return res}};
  await route({query:{industries:'Veterinary',limit:'1'}},res);
  assert.equal(body.jobs.length,1);assert(matches(body.jobs[0],['Veterinary']));assert(!('location_evidence' in body.jobs[0]));
  await route({query:{industries:'',limit:'1'}},res);assert.equal(body.jobs.length,0);

  console.log('PASS: foreign-city points excluded; new source locations validated; failed lookups clear stale points; vet customer/product evidence and dual labels; filtering beyond 1,000 rows before caps; scores unchanged; masked V7 filters refresh server results.');
})().catch(e=>{console.error(e);process.exitCode=1});
