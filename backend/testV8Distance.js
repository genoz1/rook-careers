const {test}=require('node:test');
const assert=require('node:assert/strict');
const zipcodes=require('zipcodes');
const {distanceMiles}=require('./geocoding');
const {cityQuery,classifyLocation,pointMatchesCity}=require('./jobLocationScope');
const {prepareJob}=require('./v7Location');
const {rankPool}=require('./v7Matching');
const {validateJobLocation}=require('./validateJobLocation');
const {repairCitySuffixCoordinates}=require('./repairCitySuffixCoordinates');

const topeka=zipcodes.lookup('66603');
const kansasCity=zipcodes.lookupByName('Kansas City','MO')[0];
const princeton=zipcodes.lookupByName('Princeton','NJ')[0];
const profile={home_lat:topeka.latitude,home_lng:topeka.longitude,home_state:'KS',
  desired_industries:['Diagnostics'],territory_size_preferences:[],work_style:'field'};
const base={status:'active',moderation_status:'approved',source_type:'smartrecruiters',
  ai_analysis:{product_categories:['Diagnostics']},title_original:'Director Business Development (Viracor)',
  company_name:'Eurofins',location_raw:'Princeton, NJ, us',state:'KS',
  job_lat:39.4,job_lng:-95.15};
const stale={...base,id:'eurofins',location_evidence:{version:4,status:'validated',
  source_location:base.location_raw,source_title:base.title_original,
  scope:{kind:'local',reason:'validated_source_point'},
  locations:[{lat:base.job_lat,lng:base.job_lng,state:'KS',location:base.location_raw}]}};

test('Princeton source city rejects a stale Topeka-area geocode and a stale session count',()=>{
  const q=cityQuery(base.location_raw);
  assert.equal(q.query,'Princeton, NJ');
  assert.equal(classifyLocation(stale).queries[0].state,'NJ');
  assert.equal(pointMatchesCity(stale.location_evidence.locations[0],q),false);
  assert(distanceMiles(profile.home_lat,profile.home_lng,princeton.latitude,princeton.longitude)>1000);
  assert.equal(prepareJob(stale,profile),null);
  const local={...base,id:'kansas-city',title_original:'Diagnostics Sales Representative',
    location_raw:'Kansas City, MO',state:'MO',job_lat:kansasCity.latitude,job_lng:kansasCity.longitude,
    location_evidence:null};
  const ranked=rankPool([stale,local],profile,[]);
  assert.equal(ranked.length,1);
  assert.equal(ranked[0].id,'kansas-city');
  assert(Math.abs(ranked[0].distance_miles-59)<20);
  // V8's count is the length of the very same ranked list used for cards.
  assert.equal(ranked.length,ranked.filter(j=>j.id!=='eurofins').length);
});

test('correct Princeton coordinates remain eligible near Princeton; remote scope is unchanged',()=>{
  const njProfile={...profile,home_lat:princeton.latitude,home_lng:princeton.longitude,home_state:'NJ'};
  const good={...stale,state:'NJ',job_lat:princeton.latitude,job_lng:princeton.longitude,
    location_evidence:{...stale.location_evidence,locations:[{lat:princeton.latitude,lng:princeton.longitude,state:'NJ',location:'Princeton, NJ'}]}};
  assert.equal(prepareJob(good,njProfile).geographic_eligibility.kind,'local');
  assert.equal(prepareJob(good,profile),null);
  const remote={...base,id:'remote',location_raw:'Remote, US',job_lat:null,job_lng:null,state:null,
    location_evidence:{version:4,status:'validated',source_location:'Remote, US',
      source_title:base.title_original,scope:{kind:'remote_us'}}};
  assert.equal(prepareJob(remote,{...profile,territory_size_preferences:['remote']}).geographic_eligibility.kind,'remote_us');
  assert.equal(prepareJob(remote,profile),null);
});

test('ingestion refreshes the existing bad record rather than reusing its cached point',async()=>{
  let query;
  const repaired=await validateJobLocation(base,async q=>{
    query=q;return {lat:princeton.latitude,lng:princeton.longitude,state:'NJ'};
  },stale);
  assert.equal(query,'Princeton, NJ');
  assert.equal(repaired.state,'NJ');
  assert.equal(repaired.location_evidence.locations[0].location,'Princeton, NJ');
});

test('existing malformed city rows are repaired conditionally without changing valid rows',async()=>{
  const records=[
    {...stale,updated_at:'before',description_text:''},
    {...stale,id:'already-correct',state:'NJ',job_lat:princeton.latitude,job_lng:princeton.longitude,updated_at:'before',description_text:''}
  ];
  let changed=0;
  const db={from(){let predicate=()=>true,patch=null;
    const q={
      select(){if(patch){const matches=records.filter(predicate);for(const row of matches)Object.assign(row,patch);changed+=matches.length;return Promise.resolve({data:matches.map(r=>({id:r.id})),error:null});}return q;},
      update(p){patch=p;return q;},
      eq(k,v){const prior=predicate;predicate=r=>prior(r)&&r[k]===v;return q;},
      is(k,v){const prior=predicate;predicate=r=>prior(r)&&r[k]==null;return q;},
      ilike(){return q;},order(){return q;},
      range(a,b){return Promise.resolve({data:records.filter(predicate).slice(a,b+1),error:null});}
    };return q;
  }};
  const result=await repairCitySuffixCoordinates(db);
  assert.equal(result.corrected,1);
  assert.equal(changed,1);
  assert.equal(records[0].state,'NJ');
  assert.equal(records[0].location_evidence.locations[0].location,'Princeton, NJ');
  assert.equal(records[1].job_lat,princeton.latitude);
  assert.equal((await repairCitySuffixCoordinates(db)).corrected,0);
});
