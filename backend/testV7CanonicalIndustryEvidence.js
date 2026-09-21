const assert = require('node:assert/strict');
const {scoreJob} = require('./matching');
const {rank} = require('./v7Matching');
const {classify, matches} = require('../public/rook-job-classification');
const profile = {home_lat:28.9,home_lng:-82,home_state:'FL',desired_industries:['Veterinary'],territory_size_preferences:['local']};
function job(ai, miles=48) {
  return {id:'example',title_original:'Field Sales Representative',company_name:'Anonymous employer',location_raw:'Oxford, FL',state:'FL',job_lat:profile.home_lat+miles/3958.8*180/Math.PI,job_lng:profile.home_lng,ai_analysis:ai};
}
const options={geography:{kind:'local'},smoothLocalDistance:true};
const corrected={...options,canonicalVeterinaryEvidence:true};
function db(rows) {const q={select(){return q},eq(){return q},or(){return q},order(){return q},range(a,b){return Promise.resolve({data:rows.slice(a,b+1)})}};return {from(){return q}};}
(async()=>{
  const pet=job({product_categories:['Pet insurance'],required_customer_types:['Veterinary practices','Hospital owners/staff']});
  const market=job({product_categories:[],market_industries:['Distribution','Pharmaceutical','Veterinary/Animal Health'],required_customer_types:['Distribution partners']});
  const dual=job({product_categories:['Diagnostic Analyzers','Biomarker Tests','In-Clinic Veterinary Diagnostics'],market_industries:['Veterinary/Animal Health','Diagnostics'],required_customer_types:['Veterinarians']});
  pet.id='pet';market.id='market';dual.id='dual';
  assert(matches(pet,['Veterinary'])); assert(matches(market,['Veterinary']));
  assert.deepEqual(classify(dual).labels,['Diagnostics','Veterinary']);
  for(const [j,penalty] of [[pet,20],[market,10]]) {
    const old=scoreJob(j,profile,options),now=scoreJob(j,profile,corrected);
    assert.equal(now.preference_fit-old.preference_fit,penalty);
    assert.equal(now.candidate_fit,old.candidate_fit);
    assert(!now.concerns.includes('Industry may not match your stated preference'));
    assert(now.reasons.includes('Matches your interest in Veterinary'));
    const renamed={...j,id:'different-id',company_name:'Unrelated employer',title_original:'Account Executive'};
    assert.deepEqual(scoreJob(renamed,profile,corrected),now);
  }
  for(const [ai,industry] of [[dual.ai_analysis,'Veterinary'],[dual.ai_analysis,'Diagnostics'],[{product_categories:['Diagnostics']},'Diagnostics'],[{product_categories:['Medical devices']},'Medical Device'],[{product_categories:['Animal health products']},'Veterinary']]) {
    const j=job(ai),p={...profile,desired_industries:[industry]};
    assert.deepEqual(scoreJob(j,p,corrected),scoreJob(j,p,options));
  }
  // Other category evidence-only cases are deliberately outside this Veterinary release.
  for(const industry of ['Diagnostics','Medical Device']) {
    const j=job({product_categories:['Unmatched product'],market_industries:[industry]});
    const p={...profile,desired_industries:[industry]};
    assert(matches(j,[industry]));assert.deepEqual(scoreJob(j,p,corrected),scoreJob(j,p,options));
  }
  // Negative/unknown evidence and non-V7 callers keep their established behavior.
  for(const ai of [{product_categories:['Pet insurance']},{product_categories:['Diagnostics'],required_industries:['Veterinary']},{}, {product_categories:['Vegetables']}]) {
    const j=job(ai);assert(!matches(j,['Veterinary']));
    assert.deepEqual(scoreJob(j,profile,corrected),scoreJob(j,profile,options));
  }
  const before=JSON.stringify(profile); const rows=await rank(db([pet,market,dual]),profile,['Veterinary']);
  assert.equal(rows.length,3);assert.equal(JSON.stringify(profile),before);
  assert.equal(rows.find(j=>j.id===pet.id).match.preference_fit,98);
  const saved={...profile,desired_industries:['Medical Device']};
  assert.equal((await rank(db([pet]),saved,[]))[0].match.preference_fit,78);
  assert.equal((await rank(db([pet]),saved,['Veterinary']))[0].match.preference_fit,98);
  assert.deepEqual(saved.desired_industries,['Medical Device']);
  // Same scores and distances: canonical customer-only match must not lose a tie solely for missing product keywords.
  const a={...pet,id:'a'},z={...dual,id:'z'};
  assert.equal((await rank(db([z,a]),profile,['Veterinary']))[0].id,'a');
  for(const miles of [0,25,75,75.01,150,150.01,225,299.99]) {
    const j=job(pet.ai_analysis,miles);assert.equal(scoreJob(j,profile,corrected).preference_fit,Math.round(100-15*miles/300));
  }
  assert.equal((await rank(db([job(pet.ai_analysis,301)]),profile,['Veterinary'])).length,0);
  // Correction is confined to industry preference even for a verified non-point role.
  const scoped={...market,job_lat:null,job_lng:null};
  for(const kind of ['territory','remote_us','national_us']) {
    const a=scoreJob(scoped,profile,{...options,geography:{kind}}),b=scoreJob(scoped,profile,{...corrected,geography:{kind}});
    assert.equal(b.preference_fit-a.preference_fit,10);assert.equal(b.candidate_fit,a.candidate_fit);
  }
  console.log('PASS: canonical customer/market evidence; employer independence; dual labels; unaffected category controls; negative/unknown fallback; V7 integration/tiebreaker; saved profile/All Industries; smooth distance; 300-mile gate; scope scoring.');
})().catch(e=>{console.error(e);process.exitCode=1;});
