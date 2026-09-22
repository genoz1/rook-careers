const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm');
const {validateJobLocation}=require('./validateJobLocation');
async function runCase(changed=false,lookupFailure=false,fuzzy=false){
  const previous={id:'test-row',title_original:'Senior Account Manager - Minneapolis',description_text:'our client is hiring',location_raw:'Omaha, Douglas County',job_lat:41.2587459,job_lng:-95.9383758,state:'Nebraska',location_evidence:{version:1,status:'validated',source_location:'Omaha, Douglas County',source_country_code:'US'},ai_analysis:{product_categories:['Diagnostics']},job_embedding:[1]};
  const incoming={source_job_id:'source-test',source_type:'agency_aggregated',title_original:previous.title_original,description_text:previous.description_text,location_raw:changed?'Unspecified field territory':previous.location_raw,location_evidence:{source_country_code:'US'}};
  const writes=[];let fetched=false,lookups=0,inserted=false;
  const db={from(){let columns,patch;const q={select(c){columns=c;return q;},eq(){return q;},lt(){return Promise.resolve({data:[]});},gte(){return Promise.resolve({data:[{...previous,location_raw:'Des Moines, Polk County'}]});},insert(p){patch=p;inserted=true;return q;},maybeSingle(){lookups++;return Promise.resolve(lookupFailure?{error:{message:'offline'}}:{data:fuzzy?null:Object.fromEntries(columns.split(',').map(s=>s.trim()).map(k=>[k,previous[k]]))});},update(p){patch=p;return q;},single(){writes.push(patch);return Promise.resolve({data:{...previous,...patch}});}};return q;}};
  const imports={'dotenv':{config(){}},'@supabase/supabase-js':{createClient:()=>db},'./adapters/adzuna':{fetchAdzunaJobs:async()=>{if(fetched)return [];fetched=true;return [{company:{display_name:'Recruiting Agency'},description:'our client is hiring'}];},normalizeAdzunaJob:()=>({...incoming})},'./deterministicJobAnalysis':{deterministicJobAnalysis:()=>{throw Error('unexpected enrichment');}},'./ai/embeddings':{generateEmbedding:()=>{throw Error('unexpected embedding');}},'./validateJobLocation':{validateJobLocation:(job,geo,old)=>{assert.equal(lookups,1,'must read saved evidence before validation');return validateJobLocation(job,async()=>{throw Error('no external geocoding');},old);}},'./relevanceFilter':{titleLooksRelevant:()=>true}};
  const m={exports:{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/ingestAdzuna.js','utf8').replace(/run\(\);\s*$/,'module.exports=run;'),{module:m,require:n=>{assert(n in imports,n);return imports[n];},process:{env:{}},console:{log(){},error(){}}});
  if(lookupFailure){await assert.rejects(m.exports(),/Location history lookup failed/);assert.equal(writes.length,0);return;}
  await m.exports();assert.equal(writes.length,1);const saved=writes[0];
  if(fuzzy){assert(inserted,'same title in another city must not overwrite the existing job');assert.equal(saved.location_raw,incoming.location_raw);return;}
  if(changed){assert.equal(saved.job_lat,null);assert.equal(saved.location_evidence.status,'unresolved');}
  else {assert.equal(saved.job_lat,previous.job_lat);assert.equal(saved.job_lng,previous.job_lng);assert.equal(saved.state,previous.state);assert.equal(saved.location_evidence.scope.kind,'local');}
}
(async()=>{await runCase();await runCase(true);await runCase(false,true);await runCase(false,false,true);console.log('PASS: agency refresh preserves validated county locations, rejects changed source reuse, stops writes after location-history lookup failure, and keeps same-title jobs in different cities separate.');})().catch(e=>{console.error(e);process.exitCode=1;});
