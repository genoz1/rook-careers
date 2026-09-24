const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPreparation}=require('./v7Preparation');
const {readCandidates,rankPool}=require('./v7Matching');
const vm=require('node:vm'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
const original={module:{exports:{}},require};vm.runInNewContext(execFileSync('git',['show','HEAD:backend/v7Matching.js'],{encoding:'utf8'}),original);
test('one in-flight retrieval, exact industry binding, expiry, failures and capacity fallback',async()=>{
 let reads=0,clock=0,finish;const cache=createPreparation({now:()=>clock,ttl:100,maxEntries:1,readCandidates:()=>{reads++;return new Promise(r=>finish=r);}});
 const token=cache.start({},'Veterinary');assert.equal(cache.start({},'Medical Device'),null);await Promise.resolve();assert.equal(reads,1);assert.equal(await cache.take(token,'Medical Device'),null);const pending=cache.take(token,'Veterinary');finish([{id:1}]);assert.deepEqual(await pending,[{id:1}]);assert.equal(await cache.take(token,'Veterinary'),null);
 const expired=cache.start({},'Veterinary');await Promise.resolve();clock=101;finish([{id:2}]);assert.equal(await cache.take(expired,'Veterinary'),null);
 const fail=createPreparation({readCandidates:async()=>{throw Error('database failed');}});assert.equal(await fail.take(fail.start({},'Veterinary'),'Veterinary'),null);
 const full=createPreparation({maxBytes:1,readCandidates:async()=>[{id:1}]});assert.equal(await full.take(full.start({},'Veterinary'),'Veterinary'),null);
});
test('prepared pools produce byte-equivalent scores/order to baseline across changed answers and source-backed scopes',async()=>{
 const {VERSION,descriptionHash}=require('./jobLocationScope');
 const places=[['Boston','MA',42.36,-71.06],['Orlando','FL',28.54,-81.38],['San Francisco','CA',37.77,-122.42]];
 let comparisons=0;
 for(const [city,state,lat,lng] of places){
 const local={title_original:'Sales Representative',location_raw:`${city}, ${state}`,state,job_lat:lat,job_lng:lng,status:'active',moderation_status:'approved',ai_analysis:{product_categories:['Medical Device','Veterinary']}};
 const rows=[...Array.from({length:650},(_,i)=>({...local,id:String(i).padStart(5,'0'),job_lat:lat+(i%5)*.7,experience_min_years:i%10})),...['remote_us','national_us','territory'].map(kind=>({...local,id:kind,job_lat:null,job_lng:null,location_raw:'Remote, US',location_evidence:{version:VERSION,status:'validated',source_location:'Remote, US',source_title:local.title_original,source_description_hash:descriptionHash(),scope:{kind,states:kind==='territory'?[state]:[]}}}))];
 const db={from(){return {select(){return this},eq(){return this},or(){return this},order(){return this},async range(a,b){return {data:rows.slice(a,b+1)}}}}};
 for(const industry of ['Medical Device','Veterinary','Breaking In']){const pool=await readCandidates(db,[industry]);assert.deepEqual(pool,rows);
 for(const years of [0,10])for(const territories of [['local'],['regional','national','remote']]){
 const profile={home_lat:lat,home_lng:lng,home_state:state,total_sales_years:years,desired_industries:[industry],territory_size_preferences:territories};
 const old=await original.module.exports.rank(db,profile);assert.equal(JSON.stringify(rankPool(pool,profile)),JSON.stringify(old));comparisons++;
 }} }
 assert.equal(comparisons,36);
});
test('all four onboarding screens and scorer/geographic implementation remain byte-identical',()=>{
 for(const file of ['backend/matching.js','backend/v7Location.js'])assert.equal(fs.readFileSync(file,'utf8'),execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'}));
 const file='public/rook-onboarding-v7.html';const old=execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'}),current=fs.readFileSync(file,'utf8');assert.equal(current.slice(0,current.indexOf('<script>')),old.slice(0,old.indexOf('<script>')));
});
