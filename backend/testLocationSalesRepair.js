const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyLocation,resolveLocation,VERSION}=require('./jobLocationScope');
const {validateJobLocation}=require('./validateJobLocation');
const {prepareJob}=require('./v7Location');
const {attachSearchDistance}=require('./searchDistance');
const {titleLooksRelevant,titleHasStrongSalesSignal}=require('./relevanceFilter');
const z=require('zipcodes');
const job=(title,raw,description='')=>({title_original:title,location_raw:raw,description_text:description,remote_status:'remote',location_evidence:{source_country_code:'US'}});
const geocode=async q=>{const [city,state]=q.split(', ');const p=z.lookupByName(city,state)[0];return p&&{lat:p.latitude,lng:p.longitude,state};};

test('production title formats retain verified cities rather than reducing them to states',async()=>{
 for(const [title,raw,city,state] of [['Sales Specialist Diabetes Dallas TX','Dallas, TX','Dallas','TX'],['Strategic Account Manager - Vaccine-Pittsburgh, PA','Pittsburgh, PA','Pittsburgh','PA'],['Sales Representative - Grand Rapids MI','Boston, MA','Grand Rapids','MI']]){
 const j=job(title,raw),r=await resolveLocation(j,geocode);assert.equal(r.location_evidence.scope.kind,'local');assert.equal(r.location_evidence.locations[0].location,`${city}, ${state}`);assert(Number.isFinite(r.job_lat));
 const home=await geocode(`${city}, ${state}`);const result=attachSearchDistance({...j,...r},{home_lat:home.lat,home_lng:home.lng});assert.equal(result.distance_miles,0);
 assert(prepareJob({...j,...r},{home_lat:home.lat,home_lng:home.lng,home_state:state,territory_size_preferences:['local']}));
 }
});
test('remote NYC and explicit New York City territory are city evidence; NJ remains state-only',async()=>{
 const description='The Account Territory Manager will oversee and be responsible for the Manhattan, New York City territory.';
 for(const text of ['',description]){const r=await resolveLocation(job('Account Territory Manager','US Remote - NYC | New York',text),geocode);assert.equal(r.location_evidence.scope.kind,'local');assert.equal(r.state,'NY');assert(Number.isFinite(r.job_lat));}
 const j=job('Territory Account Manager- Informatics Solutions, NA-East Region','US Remote - NJ');const r=await resolveLocation(j,geocode);
 assert.equal(r.job_lat,null);assert.deepEqual(r.location_evidence.scope.states,['NJ']);
 assert(prepareJob({...j,...r},{home_state:'NJ',home_lat:40.7,home_lng:-74.2,territory_size_preferences:['local']}));
 assert.equal(prepareJob({...j,...r},{home_state:'CA',home_lat:34,home_lng:-118,territory_size_preferences:['remote']}),null);
});
test('broad and conflicting geographic evidence never invent city points',async()=>{
 for(const j of [job('Account Manager (Ohio, Michigan & Indiana)','Georgia - Home Based'),job('Regional Sales Manager','Remote, US','Assigned territory includes Florida, Georgia, and South Carolina.'),job('National Account Manager','Boston, MA','This is a national United States territory.')]){
 const r=await resolveLocation(j,()=>{throw Error('must not geocode a broad territory');});assert.equal(r.job_lat,null);assert.equal(attachSearchDistance({...j,...r},{home_lat:40,home_lng:-75}).distance_miles,null);
 }
 assert.equal(classifyLocation(job('Account Manager','New York')).kind,'unresolved');
 assert.equal(classifyLocation(job('Account Manager','Paris, France')).kind,'foreign');
});
test('search selects nearest secondary validated point for API, display, sorting and radius',async()=>{
 const j=job('Account Manager','New York, NY | Dallas, TX');const r=await resolveLocation(j,geocode);const d=await geocode('Dallas, TX');
 const result=attachSearchDistance({...j,...r},{home_lat:d.lat,home_lng:d.lng});assert.equal(result.state,'TX');assert.equal(result.distance_miles,0);assert.equal(result.job_lat,d.lat);
 assert.equal(r.state,'NY','stored canonical point must not be mutated');
 const stale={...j,...r,location_raw:'Remote, US'};assert.equal(attachSearchDistance(stale,{home_lat:d.lat,home_lng:d.lng}).distance_miles,null);
});
test('one failed geocode cannot erase other validated locations; incomplete cache is retried',async()=>{
 const j=job('Account Manager','Dallas, TX | Boston, MA');let calls=0;
 const r=await resolveLocation(j,async q=>q==='Boston, MA'?null:geocode(q));assert(r.location_evidence.incomplete);assert(Number.isFinite(r.job_lat));assert.equal(r.location_evidence.locations.length,1);
 const refreshed=await validateJobLocation(j,async q=>{calls++;return geocode(q);},{...j,...r});assert.equal(calls,2);assert.equal(refreshed.location_evidence.incomplete,false);
});
test('old v3 territory cache is invalidated for an explicit city title',async()=>{
 const j=job('Sales Specialist Diabetes Dallas TX','Dallas, TX');const old=await resolveLocation(j,geocode);old.location_evidence.version=3;old.location_evidence.scope={kind:'territory',states:['TX']};old.job_lat=null;old.job_lng=null;
 const r=await validateJobLocation(j,geocode,{...j,...old});assert.equal(r.location_evidence.version,VERSION);assert(Number.isFinite(r.job_lat));
});
test('internal operations and service management are excluded without rejecting actual sellers',()=>{
 for(const title of ['Global Sales Ops Lead','Sales-Ops Specialist','Senior Manager, Consumer Sales and Service','Director, Sales & Customer Service','Sales Operations Manager','Sales Enablement Manager']){assert.equal(titleLooksRelevant(title),false,title);assert.equal(titleHasStrongSalesSignal(title),false,title);}
 for(const title of ['Regional Sales Manager','Territory Account Manager','Senior Inside Sales Representative (REMOTE)','Account Territory Manager','Field Sales Representative','Service Sales Representative','Sales Manager, Medical Devices']){assert.equal(titleLooksRelevant(title),true,title);assert.equal(titleHasStrongSalesSignal(title),true,title);}
});
test('targeted repair plans change only affected cities and newly excluded roles',()=>{
 const {plan}=require('./scripts/repairLocationSalesEvidence');
 assert.equal(plan({...job('Sales Specialist Diabetes Dallas TX','Dallas, TX'),location_evidence:{scope:{kind:'territory',states:['TX']}}}).action,'repair_location');
 assert.equal(plan(job('Global Sales Ops Lead','San Diego')).action,'close_internal_role');
 assert.equal(plan(job('Territory Account Manager','US Remote - NJ')),null);
 const stable=job('Territory Account Manager','Dallas, TX');stable.location_evidence.scope=classifyLocation(stable);assert.equal(plan(stable),null);
 delete stable.location_evidence.scope.states;assert.equal(plan(stable),null);
});

test("shared-state title preserves all cities",()=>{const s=classifyLocation(job("Veterinary Regional Sales Manager - Charlotte/Raleigh, NC (Royal Canin)","Charlotte, NC | Raleigh, NC"));assert.deepEqual(s.queries.map(q=>q.city).sort(),["Charlotte","Raleigh"]);});
