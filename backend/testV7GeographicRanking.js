const assert=require('node:assert/strict');
const {prepareJob}=require('./v7Location'),{resolveLocation,classifyLocation}=require('./jobLocationScope');
const {rank}=require('./v7Matching');
const {scoreJob}=require('./matching');
const profiles=[['Boston','MA',42.36,-71.06],['Louisville','KY',38.25,-85.76],['San Francisco','CA',37.77,-122.42],['Orlando','FL',28.54,-81.38],['Anchorage','AK',61.22,-149.90]].map(([home_city,home_state,home_lat,home_lng])=>({home_city,home_state,home_lat,home_lng,total_sales_years:7,desired_industries:['Diagnostics'],territory_size_preferences:['local']}));
function job(raw,lat,lng,state){return {id:raw,title_original:'Account Executive',location_raw:raw,job_lat:lat,job_lng:lng,state,status:'active',moderation_status:'approved',ai_analysis:{product_categories:['Diagnostics']},location_evidence:{version:1,status:lat==null?'unresolved':'validated',source_country_code:'US',source_location:raw}};}
function reviewed(kind,states=[]){const j=job('Remote, US',null,null,null);j.location_evidence={...j.location_evidence,version:2,status:'validated',source_title:j.title_original,scope:{kind,states}};return j;}
function db(rows,fail=false){let filters=[];const q={select(){return q;},eq(k,v){filters.push(j=>j[k]===v);return q;},or(){return q;},order(){return q;},range(a,b){const data=rows.filter(j=>filters.every(f=>f(j)));return Promise.resolve(fail&&a>0?{error:{message:'page failed'}}:{data:data.slice(a,b+1)});}};return {from(){filters=[];return q;}};}
(async()=>{
  for(const p of profiles){
    const local=job(`${p.home_city}, ${p.home_state}`,p.home_lat,p.home_lng,p.home_state);
    assert(prepareJob(local,p));
    const boundary=job('Boundary, US',p.home_lat+300/3958.8*180/Math.PI-1e-7,p.home_lng,p.home_state);
    assert(prepareJob(boundary,p));boundary.job_lat+=.0001;assert.equal(prepareJob(boundary,p),null);
    const far=job('Miami, FL',25.77,-80.19,'FL');if(p.home_city!=='Orlando')assert.equal(prepareJob(far,{...p,territory_size_preferences:['remote','national']}),null);
    const unknown=job('Remote',null,null,null);assert.equal(prepareJob(unknown,{...p,territory_size_preferences:['remote','national']}),null);
    const territory=reviewed('territory',[p.home_state]);assert(prepareJob(territory,p));assert.equal(prepareJob(reviewed('territory',['ZZ']),p),null);
    assert.equal(prepareJob(reviewed('remote_us',['ZZ']),{...p,territory_size_preferences:['remote']}),null);
    assert.equal(prepareJob(reviewed('remote_us'),p),null);assert(prepareJob(reviewed('remote_us'),{...p,territory_size_preferences:['remote']}));assert.equal(prepareJob(reviewed('remote_us'),{...p,territory_size_preferences:['national']}),null);
    assert(prepareJob(reviewed('national_us'),{...p,territory_size_preferences:['national']}));
    assert.equal(prepareJob({...reviewed('remote_us'),location_raw:'Remote, Poland'},{...p,territory_size_preferences:['remote']}),null);
    const multi=job('Miami, FL | '+local.location_raw,25.77,-80.19,'FL');multi.location_evidence.locations=[{lat:25.77,lng:-80.19,state:'FL'},{lat:p.home_lat,lng:p.home_lng,state:p.home_state}];assert.equal(prepareJob(multi,p).job_lat,p.home_lat);
    const rows=Array.from({length:650},(_,i)=>({...local,id:String(i).padStart(6,'0'),job_lat:p.home_lat+(i===649?0:1.5),ai_analysis:{product_categories:['Diagnostics']},experience_min_years:i===649?0:25}));
    rows.unshift(...Array.from({length:450},(_,i)=>({...unknown,id:'unknown-'+i})));
    const result=await rank(db(rows),p);assert(result.some(j=>j.id==='000649'));assert.equal(result.length,300);
    const reverse=await rank(db([...rows].reverse()),p);assert.deepEqual(reverse.map(j=>j.id),result.map(j=>j.id));
    await assert.rejects(()=>rank(db(rows,true),p),/page failed/);
    assert.deepEqual(scoreJob(local,p),scoreJob(local,p,{geography:{kind:'local'}}));
  }
  const j=job('United States Remote Office | California, USA',null,null,null);j.title_original='Professional Sales Representative - San Francisco, CA';assert.equal(classifyLocation(j).queries[0].query,'San Francisco, CA');
  const patch=await resolveLocation(j,async()=>({lat:37.77,lng:-122.42,state:'CA'}));assert(prepareJob({...j,...patch},profiles[2]));assert.equal(prepareJob({...j,...patch},profiles[0]),null);
  assert.equal(classifyLocation({...j,title_original:'Procedural Sales Specialist - MN / IA / ND / SD',location_raw:'USA GA - Covington BMD'}).kind,'territory');
  assert.equal(classifyLocation(job('London, England, gb',null,null,null)).kind,'foreign');
  assert.equal(classifyLocation(job('United States',null,null,null)).kind,'unresolved');
  assert.equal(classifyLocation({...j,location_raw:'Boston or Remote',location_evidence:{status:'unresolved'}}).kind,'unresolved');
  console.log('PASS: five real locations, inclusive 300-mile boundary, broad preference isolation, source scopes, secondary locations, >400 competition, deterministic sorting, page failure, ingestion repair and foreign ambiguity.');
})().catch(e=>{console.error(e);process.exitCode=1;});
