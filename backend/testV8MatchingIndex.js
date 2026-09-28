const test=require('node:test'),assert=require('node:assert/strict');
const {createIndex,compact}=require('./v8MatchingIndex');
const {pages}=require('./v8Matching');
const {rank:oldRank,rankPool,hydrateDescriptionTerritories,JOB_LIST_COLUMNS_NO_DESCRIPTION}=require('./v7Matching');
const {database}=require('./v8TestDatabase');
const {resolveLocation,LOCAL_MATCHING_SCOPE}=require('./jobLocationScope');
const zipcodes=require('zipcodes');
const job={id:'one',status:'active',moderation_status:'approved',location_raw:'Topeka, KS',title_original:'Sales Representative',job_lat:39.0489,job_lng:-95.678,state:'KS',ai_analysis:{product_categories:['Diagnostics'],required_industries:[],summary:'private details'},company_name:'Private Employer',application_url:'https://private.example',description_text:'A complete private description'};
function source(rows=[job]){
  const base=database(rows);let rev=1,fail=false,checks=0;
  return {set revision(v){rev=v;},set fail(v){fail=v;},get checks(){return checks;},from(name){
    if(name!=='v8_matching_revision')return base.from(name);
    return {select(){return this;},eq(){return this;},single:async()=>{checks++;return fail?{error:{message:'offline'}}:{data:{revision:rev}};}};}};
}
test('both instances rebuild independently; direct search has no freshness round trip; stale and missing never return old index',async()=>{
  const db=source(),a=createIndex(db,{readPages:pages}),b=createIndex(db,{readPages:pages});
  const missing={};assert.equal(await a.current(missing),null);assert.equal(missing.database_fallback,1);
  await a.refresh();await b.refresh();
  const n=db.checks,t={validate_with_session:true};assert.equal((await a.current(t)).length,1);assert.equal(db.checks,n);assert.equal(t.index_revision,'1');
  db.revision=2;assert.equal(await a.current({}),null);await a.refresh();await b.refresh();
  for(const index of [a,b]){const t={};await index.current(t);assert.equal(t.index_revision,'2');}
  db.fail=true;assert.equal(await a.current({}),null);
});
test('concurrent inventory mutation and partial reads never publish an index',async()=>{
  const db=source();const index=createIndex(db,{readPages:async()=>{db.revision=2;return [job];}});
  await assert.rejects(index.refresh(),/changed during/);
  const failed=createIndex(source(),{readPages:async()=>{throw Error('page failed');}});
  await assert.rejects(failed.refresh(),/page failed/);
});
test('compact projection excludes details and preserves original source-backed territory and score',async()=>{
  const full={...job,description_text:'Assigned territory includes Kansas, Missouri, and Colorado.'};
  Object.assign(full,await resolveLocation(full,async()=>null));
  const thin=compact(full),p={home_lat:39.0489,home_lng:-95.678,home_state:'KS',desired_industries:['Diagnostics'],territory_size_preferences:[]};
  for(const key of ['company_name','application_url','description_text','description_html','extraction_evidence'])assert(!(key in thin));
  assert(!('summary' in thin.ai_analysis));assert(thin[LOCAL_MATCHING_SCOPE]);
  const signature=rows=>rows.map(j=>({id:j.id,match:j.match,distance:j.distance_miles,geo:j.geographic_eligibility}));
  assert.deepEqual(signature(rankPool([thin],p,[])),signature(rankPool([full],p,[])));
});
test('production inventory compact-index equivalence over existing 15 location/industry profiles',async t=>{
  const path=process.env.V8_INVENTORY_FILE;if(!path){t.skip('Set V8_INVENTORY_FILE for real-inventory equivalence');return;}
  const rows=JSON.parse(require('node:fs').readFileSync(path));const db=database(rows);
  const sourceRows=await pages(db,JOB_LIST_COLUMNS_NO_DESCRIPTION,{candidate_page_reads:0});
  const thin=(await hydrateDescriptionTerritories(db,sourceRows)).map(compact);
  const signature=jobs=>jobs.map(j=>({id:j.id,match:j.match,distance:j.distance_miles,geo:j.geographic_eligibility}));
  for(const [city,state] of [['Topeka','KS'],['Princeton','NJ'],['Miami','FL'],['San Francisco','CA'],['Anchorage','AK']]){
    const place=zipcodes.lookupByName(city,state)[0];
    for(const industry of ['Diagnostics','Medical Device','Veterinary']){
      const profile={home_lat:place.latitude,home_lng:place.longitude,home_state:state,desired_industries:[industry],territory_size_preferences:[],work_style:'field',total_sales_years:null};
      assert.deepEqual(signature(rankPool(thin,profile,[])),signature(await oldRank(db,profile,[])),city+': '+industry);
    }
  }
  console.log('Production index:',rows.length,'rows;',Buffer.byteLength(JSON.stringify(thin)),'bytes (plus derived scopes)');
});
test('SQL migration invalidates writes and atomically rejects stale previews without saving sessions',async()=>{
  const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create table jobs(id uuid primary key,company_name text,city text,application_url text,source_url text,status text,moderation_status text);
      create table onboarding_v7_sessions(token_hash text primary key,profile jsonb,jobs jsonb,expires_at timestamptz);`);
    await db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../migration_v8_matching_revision.sql'),'utf8'));
    const id='00000000-0000-0000-0000-000000000001';
    await db.query("insert into jobs values($1,'Employer','Topeka','https://apply.example','https://source.example','active','approved')",[id]);
    const getRevision=async()=>String((await db.query('select revision from v8_matching_revision')).rows[0].revision);
    const revision=await getRevision();
    const save=async rev=>(await db.query("select create_v8_preview_session($1,$2,now()+interval '1 day',$3,$4) as result",['a'.repeat(64),{onboarding_version:'v8'},rev,[id]])).rows[0].result;
    assert.equal((await save('1')).accepted,false);
    assert.equal((await db.query('select * from onboarding_v7_sessions')).rows.length,0);
    assert.equal((await save(revision)).accepted,true);
    assert.deepEqual((await db.query('select jobs from onboarding_v7_sessions')).rows[0].jobs,[]);
    await db.query("update jobs set status='closed' where id=$1",[id]);
    assert.notEqual(await getRevision(),revision);assert.equal((await save(revision)).accepted,false);
    await db.exec('set role anon');await assert.rejects(db.query('select * from v8_matching_revision'),/permission denied/);
    await assert.rejects(save(await Promise.resolve(revision)),/permission denied/);
  }finally{await db.close();}
});
