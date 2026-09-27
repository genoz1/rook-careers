const {test}=require('node:test');
const assert=require('node:assert/strict');
const zipcodes=require('zipcodes');
const {distanceMiles}=require('./geocoding');
const {cityQuery,classifyLocation,pointMatchesCity,resolveLocation}=require('./jobLocationScope');
const {prepareJob}=require('./v7Location');
const {rankPool,hydrateDescriptionTerritories}=require('./v7Matching');
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
  const description='Role: Business Development Director Department: Biopharma Sales '+
    'Location: Corporate (Lenexa, KS) / Remote/Supporting Mid-Atlantic/East Coast territory '+
    'Basic Function: primarily responsible for growing regional clients in the West Coast territory.';
  const oldHq={...stale,id:'eurofins-hq',description_text:description,
    location_evidence:{...stale.location_evidence,scope:{kind:'local',
      queries:[{query:'Lenexa, KS',city:'Lenexa',state:'KS'}],reason:'explicit_description_territory'}}};
  assert.equal(classifyLocation(oldHq).queries[0].state,'NJ');
  assert.equal(prepareJob(oldHq,profile),null);
  const records=[
    {...oldHq,updated_at:'before'},
    {...stale,id:'generic-city',location_raw:'Princeton, NJ',updated_at:'before',description_text:'',
      location_evidence:{...stale.location_evidence,source_location:'Princeton, NJ'}},
    {...stale,id:'already-correct',state:'NJ',job_lat:princeton.latitude,job_lng:princeton.longitude,updated_at:'before',description_text:''}
  ];
  let changed=0;
  const db={from(){let predicate=()=>true,patch=null;
    const q={
      select(){if(patch){const matches=records.filter(predicate);for(const row of matches)Object.assign(row,patch);changed+=matches.length;return Promise.resolve({data:matches.map(r=>({id:r.id})),error:null});}return q;},
      update(p){patch=p;return q;},
      eq(k,v){const prior=predicate;predicate=r=>prior(r)&&r[k]===v;return q;},
      is(k,v){const prior=predicate;predicate=r=>prior(r)&&r[k]==null;return q;},
      not(k,operator,value){const prior=predicate;predicate=r=>prior(r)&&r[k]!=null;return q;},
      ilike(){return q;},order(){return q;},
      range(a,b){return Promise.resolve({data:records.filter(predicate).slice(a,b+1),error:null});}
    };return q;
  }};
  const result=await repairCitySuffixCoordinates(db);
  assert.equal(result.corrected,2);
  assert.equal(changed,2);
  assert.equal(records[0].state,'NJ');
  assert.equal(records[0].location_evidence.locations[0].location,'Princeton, NJ');
  assert.equal(records[1].state,'NJ');
  assert.equal(records[2].job_lat,princeton.latitude);
  assert.equal((await repairCitySuffixCoordinates(db)).corrected,0);
});

test('explicit multi-city and large regional territories still match inside their stated coverage',async()=>{
  const geocode=async query=>{
    const [city,state]=query.split(', ');
    const place=zipcodes.lookupByName(city,state)[0];
    return place?{lat:place.latitude,lng:place.longitude,state}:null;
  };
  const job={...base,title_original:'Territory Account Manager',location_raw:'Cambridge, MA',
    state:null,job_lat:null,job_lng:null,location_evidence:null};
  const forRanking=(resolved)=>{
    const input={...job,...resolved};
    delete input.description_text; // V8's ranking query omits descriptions.
    return input;
  };
  const cities=await resolveLocation({...job,description_text:
    'Assigned territory includes Miami, Fort Lauderdale, and West Palm Beach, Florida.'},geocode);
  assert.equal(cities.location_evidence.scope.kind,'local');
  assert.equal(cities.location_evidence.locations.length,3);
  const miami=zipcodes.lookupByName('Miami','FL')[0];
  const cityMatch=prepareJob(forRanking(cities),{...profile,home_lat:miami.latitude,
    home_lng:miami.longitude,home_state:'FL'});
  assert.equal(cityMatch.geographic_eligibility.kind,'local');
  assert(cityMatch.geographic_eligibility.distance_miles<10);
  const region=await resolveLocation({...job,description_text:
    'Assigned territory includes Florida, Georgia, and South Carolina.'},geocode);
  assert.equal(region.location_evidence.scope.kind,'territory');
  assert.deepEqual(region.location_evidence.scope.states.sort(),['FL','GA','SC']);
  assert.equal(prepareJob(forRanking(region),{...profile,home_state:'GA'}).geographic_eligibility.kind,'territory');
  assert.equal(prepareJob(forRanking(region),{...profile,home_state:'KS'}),null);
  // SmartRecruiters also supplies lowercase country suffixes. The ranking
  // query hydrates only description-backed rows so a real territory is not
  // lost merely because the fast job-pool query omitted its description.
  const suffix={...job,id:'multi-city-suffix',location_raw:'Cambridge, MA, us'};
  const suffixDescription='Assigned territory includes Miami, Fort Lauderdale, and West Palm Beach, Florida.';
  const suffixEvidence=await resolveLocation({...suffix,description_text:suffixDescription},geocode);
  const stored={...suffix,...suffixEvidence};
  const db={from(){return {select(){return this;},in(){return Promise.resolve({data:[
    {id:stored.id,description_text:suffixDescription}],error:null});}}}};
  const [hydrated]=await hydrateDescriptionTerritories(db,[stored]);
  assert.equal(hydrated.description_text,suffixDescription);
  assert.equal(prepareJob(hydrated,{...profile,home_lat:miami.latitude,
    home_lng:miami.longitude,home_state:'FL'}).geographic_eligibility.kind,'local');
});
