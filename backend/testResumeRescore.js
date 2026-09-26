const {test}=require('node:test');
const assert=require('node:assert/strict');
const {scoreJob}=require('./matching');
const {scoreAndStoreForCandidate}=require('./scoring/precompute');

test('replacement résumé profile is used to rescore and persist current candidate-job rows',async()=>{
  const job={
    id:'replacement-resume-job',
    title_original:'Diagnostics Account Executive',
    description_text:'Sell diagnostic testing to physician practices.',
    location_raw:'Oxford, FL',
    state:'FL',
    job_lat:28.9,
    job_lng:-82,
    industry:'Diagnostics',
    status:'active',
    moderation_status:'approved',
    ai_analysis:{required_industries:['Diagnostics'],product_categories:['Diagnostics'],required_customer_types:['Physicians'],sales_motion:['Hunter'],seniority_level:'Account Executive'},
  };
  const replacementProfile={
    id:'replacement-resume-candidate',
    user_id:'replacement-resume-user',
    home_lat:28.9,
    home_lng:-82,
    home_state:'FL',
    desired_industries:['Diagnostics'],
    resume_structured:{industries_experience:[{industry:'Diagnostics',years_estimate:6}],product_categories:['Diagnostics'],customer_types:['Physicians'],sales_motion:['Hunter'],seniority_level:'Account Executive',total_sales_years:6,management_experience:false,clinical_technical_experience:[],specialties:[],certifications:[],performance_highlights:[],employers:[]},
  };
  const oldProfile={...replacementProfile,resume_structured:{industries_experience:[{industry:'Veterinary/Animal Health',years_estimate:4}],product_categories:['Animal Health'],customer_types:['Veterinarians'],sales_motion:['Account Management'],seniority_level:'Account Executive',total_sales_years:4,management_experience:false,clinical_technical_experience:[],specialties:[],certifications:[],performance_highlights:[],employers:[]}};
  const expected=scoreJob(job,replacementProfile);
  const oldScore=scoreJob(job,oldProfile);
  let persisted=[];
  const db={from(table){
    if(table==='jobs')return{select(){return this;},eq(){return this;},order(){return this;},range:async()=>({data:[job],error:null})};
    if(table==='candidate_job_matches')return{upsert:async(rows)=>{persisted.push(...rows);return{error:null};}};
    if(table==='candidate_profiles')return{update(){return this;},eq:async()=>({error:null})};
    throw new Error(`Unexpected table ${table}`);
  }};
  const result=await scoreAndStoreForCandidate(db,replacementProfile);
  assert.equal(result.scoredCount,1);
  assert.equal(persisted.length,1);
  assert.equal(persisted[0].candidate_id,replacementProfile.id);
  assert.equal(persisted[0].job_id,job.id);
  assert.equal(persisted[0].candidate_fit,expected.candidate_fit);
  assert.equal(persisted[0].overall_score,expected.overall_score);
  assert.notEqual(persisted[0].candidate_fit,oldScore.candidate_fit);
  assert.ok(persisted[0].scored_at);
});
