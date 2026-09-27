const assert=require('node:assert/strict');
const fs=require('node:fs');
const {validate,prioritize,reveal}=require('./routes/onboardingV8')._test;
const {project}=require('./pretrialProjection');
const base={location:{lat:28.9,lng:-82,city:'Oxford',state:'FL',zip:'34484',label:'Oxford, FL'},industry:'Diagnostics'};
const p=validate(base);
assert.equal(p.total_sales_years,null);assert.deepEqual(p.territory_size_preferences,[]);
assert.equal(validate({...base,location:{...base.location,state:'Florida',stateAbbr:'FL'}}).home_state,'FL');
assert.throws(()=>validate({...base,location:{...base.location,lat:999}}));
assert.throws(()=>validate({...base,industry:'all'}));
const jobs=[
 {id:'a',title_original:'Exact Device Title',company_name:'Device Employer',source_url:'https://secret.example/a',ai_analysis:{product_categories:['Medical Device']},match:{overall_score:80}},
 {id:'b',title_original:'Exact Diagnostics Title',company_name:'Diagnostics Employer',source_url:'https://secret.example/b',ai_analysis:{product_categories:['Diagnostics']},match:{overall_score:75}},
 {id:'c',title_original:'Exact Veterinary Title',company_name:'Veterinary Employer',source_url:'https://secret.example/c',ai_analysis:{product_categories:['Veterinary']},match:{overall_score:70}}
];
const ranked=prioritize(jobs,'Diagnostics');
assert.equal(ranked.length,3);assert.equal(ranked[0].id,'b');assert.deepEqual(jobs.map(j=>j.id),['a','b','c']);
const first=reveal(ranked[0]);assert.equal(first.title_original,'Exact Diagnostics Title');assert.equal(first.company_name,'Diagnostics Employer');
const locked=project(ranked[2],2,{dashboard:true});assert.equal(locked.subscription_required,true);
for(const secret of ['Exact Veterinary Title','Veterinary Employer','https://secret.example/c','"id":"c"'])assert(!JSON.stringify(locked).includes(secret),secret);
for(const file of ['rook-onboarding-v7.html','rook-dashboard-v7.html','rook-v7.js','rook-pretrial.css'])assert(fs.existsSync('public/'+file));
const v8=fs.readFileSync('public/rook-onboarding-v8.html','utf8');assert(v8.includes('rook-v8.css')&&v8.includes('rook-v8.js')&&!v8.includes('rook-v7.js'));
const js=fs.readFileSync('public/rook-v8.js','utf8');assert(js.includes('rook-onboarding-v8-signup.html')&&js.includes('data-locked')&&js.includes('onboarding_version:\'v8\''));
const checkout=fs.readFileSync('public/rook-checkout-v8.html','utf8');assert(checkout.includes('rook-onboarding-v8.html?trial=started'));
console.log('PASS V8 profile validation, preference ranking retains all industries, two-job reveal, sanitized locked projection, isolated routes and handoff.');
