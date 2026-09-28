const {test}=require('node:test');
const assert=require('node:assert/strict');
const {rank:oldRank}=require('./v7Matching');
const {rank:newRank}=require('./v8Matching');
const {prepareJob}=require('./v7Location');
const {VERSION,resolveLocation}=require('./jobLocationScope');
const zipcodes=require('zipcodes');
const {database}=require('./v8TestDatabase');
const profile=(city,state,industry='Diagnostics')=>{const p=zipcodes.lookupByName(city,state)[0];return {home_lat:p.latitude,home_lng:p.longitude,home_state:state,desired_industries:[industry],territory_size_preferences:[],work_style:'field',total_sales_years:null};};
const job=(id,city,state)=>{const p=zipcodes.lookupByName(city,state)[0];return {id,status:'active',moderation_status:'approved',title_original:'Sales Representative',location_raw:`${city}, ${state}`,job_lat:p.latitude,job_lng:p.longitude,state,ai_analysis:{product_categories:['Diagnostics','Medical Device','Veterinary']}};};
async function fixtures(){
  const local=job('local','Topeka','KS'),far=job('far','Princeton','NJ');
  const geocode=async query=>{const [city,state]=query.split(', '),p=zipcodes.lookupByName(city,state)[0];return p?{lat:p.latitude,lng:p.longitude,state}:null;};
  const descriptionJob=async(id,text)=>{const j={...far,id,description_text:text};return {...j,...await resolveLocation(j,geocode)};};
  return [local,far,
    await descriptionJob('multi-city','Assigned territory includes Topeka, KS and Denver, CO.'),
    await descriptionJob('multi-state','Assigned territory includes Kansas, Missouri, and Colorado.'),
    ...['Headquarters in Topeka, KS.','Corporate office in Topeka, KS.','Mailing address: Topeka, KS.','Manufacturing site in Topeka, KS.','Our company was founded in Topeka, KS.','An unrelated facility is in Topeka, KS.'].map((description_text,i)=>({...far,id:'incidental-'+i,description_text})),
    {...far,id:'remote',location_raw:'Remote, US',job_lat:null,job_lng:null,state:null,location_evidence:{version:VERSION,status:'validated',source_country_code:'US',source_location:'Remote, US',source_title:far.title_original,scope:{kind:'remote_us'}}},
    {...far,id:'missing',job_lat:null,job_lng:null},
    {...local,id:'secondary',location_raw:'Princeton, NJ | Topeka, KS',job_lat:far.job_lat,job_lng:far.job_lng,state:'NJ',location_evidence:{status:'validated',source_location:'Princeton, NJ | Topeka, KS',locations:[{lat:far.job_lat,lng:far.job_lng,state:'NJ'},{lat:local.job_lat,lng:local.job_lng,state:'KS'}]}}
  ];
}
test('geography fixtures preserve territories and reject incidental descriptions',async()=>{
  const rows=await fixtures(),p=profile('Topeka','KS');
  for(const id of ['local','multi-city','multi-state','secondary'])assert(prepareJob(rows.find(j=>j.id===id),p),id);
  for(const j of rows.filter(j=>j.id==='far'||j.id.startsWith('incidental-')||j.id==='remote'))assert.equal(prepareJob(j,p),null,j.id);
  assert(prepareJob(rows.find(j=>j.id==='remote'),{...p,territory_size_preferences:['remote']}));
  for(const miles of [299.99,300.01]){
    const j={...rows[0],location_raw:'Boundary, US',job_lat:p.home_lat+miles/3958.8*180/Math.PI,location_evidence:{status:'validated',source_country_code:'US',source_location:'Boundary, US'}};
    assert.equal(!!prepareJob(j,p),miles<300);
  }
});
test('identical old/new ranked identities, scores, distances and order over 5,520 candidates',async()=>{
  const seeds=await fixtures();
  const rows=Array.from({length:5520},(_,i)=>({...seeds[i%seeds.length],id:String(i).padStart(6,'0')}));
  for(const [city,state] of [['Topeka','KS'],['Princeton','NJ'],['Miami','FL'],['San Francisco','CA'],['Anchorage','AK']]){
    for(const industry of ['Diagnostics','Medical Device','Veterinary']){
      const p=profile(city,state,industry),timing={};
      const before=await oldRank(database(rows),p,[]),after=await newRank(database(rows),p,[],timing);
      assert.deepEqual(after,before,`${city}: ${industry}`);
      assert.equal(timing.candidate_count,5520);assert.equal(timing.candidate_page_reads,12);
      assert(timing.scoring_candidate_count<5520);
    }
  }
});
test('partial page failure fails closed instead of returning incomplete rankings',async()=>{
  await assert.rejects(newRank(database(Array.from({length:1200},(_,i)=>job(String(i),'Topeka','KS')),{fail:true}),profile('Topeka','KS')),/retrieval failed/);
});

