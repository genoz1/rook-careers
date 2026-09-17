const assert = require('node:assert/strict');
const {prepareJob} = require('./v7Location');
const {validateJobLocation} = require('./validateJobLocation');
const {scoreJob} = require('./matching');
const profile={home_lat:28.93,home_lng:-81.97,home_city:'The Villages',home_state:'Florida',desired_industries:['Veterinary'],total_sales_years:10,territory_size_preferences:['local']};
const base={title_original:'Veterinary Sales Representative',company_name:'Employer',industry:'Veterinary',location_raw:'Sanford, FL',state:'FL',job_lat:28.8,job_lng:-81.27};
(async()=>{
  assert.equal(prepareJob({...base,location_raw:'US Territory Field based',title_original:'Veterinary Sales Representative - Asheville',job_lat:null,job_lng:null},profile),null);
  assert.equal(prepareJob({...base,location_raw:'US NJ Remote | US NY Remote',state:'NJ',job_lat:40.1,job_lng:-74.5,remote_status:'remote'},profile),null);
  const jacksonville={...profile,home_lat:30.33,home_lng:-81.66};
  const georgia={...base,location_raw:'Brunswick, GA',state:'GA',job_lat:31.15,job_lng:-81.49};
  assert(prepareJob(georgia,jacksonville));
  assert.equal(prepareJob({...base,location_raw:'Miami, FL',job_lat:25.77,job_lng:-80.19},jacksonville),null);
  const missing={...base,location_raw:'US Territory Field based',job_lat:null,job_lng:null};
  for (const choice of ['national','remote']) {
    const broad={...profile,territory_size_preferences:[choice]};
    assert(prepareJob(missing,broad));
    const nj=prepareJob({...base,location_raw:'US NJ Remote | US NY Remote',state:'NJ',job_lat:40.1,job_lng:-74.5,remote_status:'remote'},broad);
    assert(nj);
    const statewide=prepareJob({...base,location_raw:'Remote - Florida'},broad);assert(statewide);assert.equal(statewide.job_lat,null);
    assert.equal(prepareJob({...missing,location_raw:'Warsaw, Poland'},broad),null);
  }
  assert.equal(prepareJob(missing,{...profile,territory_size_preferences:['regional']}),null);
  const local=prepareJob(base,profile);assert(local);assert.deepEqual(scoreJob(local,profile),scoreJob(base,profile));
  const raw="USA - Florida - Springhill | USA - Florida - Eustis | USA - Florida - Land O' Lakes | USA - Florida - The Villages";
  const point={lat:28.93,lng:-81.97,state:'Florida'};
  let calls=[];
  const evidence=await validateJobLocation({...base,location_raw:raw},async text=>{calls.push(text);return text.startsWith('The Villages')?point:{lat:28.48,lng:-82.53,state:'Florida'};});
  assert.equal(calls.length,4);assert.equal(evidence.location_evidence.locations.length,4);
  const result=prepareJob({...base,...evidence,location_raw:raw},profile);
  assert.equal(result.job_lat,point.lat);assert.equal(result.job_lng,point.lng);
  assert.equal(evidence.job_lat,28.48,'stored primary point must remain unchanged');
  const other={...profile,home_lat:28.48,home_lng:-82.53};assert.equal(prepareJob({...base,...evidence,location_raw:raw},other).job_lat,28.48);
  const forged={...base,location_raw:'New York, NY',state:'NY',job_lat:40.71,job_lng:-74,location_evidence:{status:'validated',source_location:raw,locations:[point]}};assert.equal(prepareJob(forged,profile),null);
  const cached=await validateJobLocation({...base,location_raw:raw},()=>{throw Error('unexpected lookup');},{...evidence});assert.deepEqual(cached.location_evidence.locations,evidence.location_evidence.locations);
  console.log('PASS: remote territory exclusions, unchanged shared scorer, nearest validated multi-location selection, immutable primary point, stale evidence rejection, cached ingestion.');
})().catch(e=>{console.error(e);process.exitCode=1;});
