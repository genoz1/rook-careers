const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {project}=require('./pretrialProjection');const {hasFullAccess}=require('./matching');
const {preview}=require('./v7Preview');const {redactForNonSubscriber,redactForAnonymous}=require('./redaction');
const canary={id:'private-job-id',title_original:'Unique Oncology Account Manager BrandXYZ',title_normalized:'Unique Title',company_name:'HiddenEmployer',source_job_id:'ReqSecret8842',source_url:'https://secret.example/source',application_url:'https://secret.example/apply',description_text:'Confidential job description and BrandXYZ',description_html:'<p>HiddenEmployer</p>',location_raw:'DistinctCity, FL',city:'DistinctCity',territory:'Unique District Wording',product_type:'BrandXYZ',employer_note:'HiddenEmployer employment history',new_sensitive_field:'future secret',ai_analysis:{product_categories:['Pharmaceutical'],unrecognized:'secret AI text'},category:'Account Management',distance_miles:48,match:{overall_score:100,preference_fit:100,candidate_fit:null,recommendation:'Strong Match',reasons:['HiddenEmployer'],concerns:['DistinctCity'],categories:{secret:'BrandXYZ'}}};
const permitted=['id','subscription_required','industry_classification','role_type','distance_miles','territory_type','freshness_label','match'].sort();
test('all locked projectors omit arbitrary source fields and nested text without mutating source',()=>{
 const original=JSON.stringify(canary);
 for(const fn of [project,preview,redactForNonSubscriber]){
  const result=fn(canary,2);assert.deepEqual(Object.keys(result).sort(),permitted);assert.equal(result.id,'locked-2');
  assert(!/HiddenEmployer|BrandXYZ|DistinctCity|Unique|ReqSecret|secret\.example|private-job-id|future secret/.test(JSON.stringify(result)));
  assert.equal(result.match.preference_fit,100);assert.equal(result.match.candidate_fit,null);assert.equal(result.role_type,'Account Management');assert.equal(result.territory_type,null);
 }
 assert.equal(JSON.stringify(canary),original);assert.equal(redactForAnonymous(canary).match,undefined);
});
test('unknown structured attributes never become fabricated industry, role or territory',()=>{
 const r=project({category:'random unknown words',territory:'Headquarters in New York',industry:'made up industry',distance_miles:NaN,match:{preference_fit:Infinity}});
 assert.deepEqual(r.industry_classification.labels,[]);assert.equal(r.role_type,null);assert.equal(r.territory_type,null);assert.equal(r.distance_miles,null);assert.equal(r.match.preference_fit,null);
});
test('all required access states retain the same originals only for valid entitlements',()=>{
 for(const [name,profile,full] of [['anonymous',null,false],['pretrial',{},false],['returning',{},false],['abandoned',{subscription_status:'incomplete'},false],['trialing',{subscription_status:'trialing',trial_ends_at:'2099-01-01'},true],['active',{subscription_status:'active'},true],['canceled',{subscription_status:'cancelled'},false],['expired',{subscription_status:'trialing',trial_ends_at:'2020-01-01'},false]]){
  assert.equal(hasFullAccess(profile),full,name);const result=hasFullAccess(profile)?canary:project(canary);assert.equal(result.title_original,full?canary.title_original:undefined,name);
 }
});
if(process.env.ROOK_SECURITY_SAMPLES) test('four targeted real production jobs withhold distinctive fields and preserve full originals',()=>{
 const rows=JSON.parse(fs.readFileSync(process.env.ROOK_SECURITY_SAMPLES));assert.equal(rows.length,4);
 for(const {industry,job} of rows){const before=JSON.stringify(job);const result=project(job);const serialized=JSON.stringify(result);
  for(const k of ['title_original','company_name','description_text','source_url','application_url','source_job_id']) {assert.equal(result[k],undefined,industry+': '+k);if(typeof job[k]==='string'&&job[k].length>8)assert(!serialized.includes(job[k]),industry+': '+k);}
  assert.equal(JSON.stringify(job),before);assert.equal(hasFullAccess({subscription_status:'trialing'}),true);assert.equal(job.title_original,JSON.parse(before).title_original);
 }
});

test('candidate profile updates cannot grant access, reset trial eligibility or reassign ownership',()=>{
 const write=require('./profileWriteBoundary');
 const result=write({name:'Candidate',home_lat:28,desired_industries:['Diagnostics'],resume_structured:{employers:[]},subscription_status:'active',trial_started_at:null,trial_ends_at:'2099-01-01',subscription_cancel_at:null,stripe_customer_id:'another_customer',id:'another_profile',user_id:'another_user',new_admin_flag:true});
 assert.deepEqual(result,{name:'Candidate',home_lat:28,desired_industries:['Diagnostics'],resume_structured:{employers:[]}});
});
