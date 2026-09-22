const {test}=require('node:test');
const assert=require('node:assert/strict');
const zipcodes=require('zipcodes');
const fs=require('fs');
const {attachSearchDistance}=require('./searchDistance');
const {stateCodesInText}=require('./jobLocationScope');
const {withinRadius,includesSearchArea}=require('../public/rook-territory-location');
const {distanceMiles}=require('./geocoding');
const point=zip=>{const z=zipcodes.lookup(zip);return {lat:z.latitude,lng:z.longitude};};
const territory=(label,states)=>({title_original:`Sales Representative (${label})`,location_raw:'Remote',job_lat:null,job_lng:null,location_evidence:{version:4,source_location:'Remote',status:'validated',scope:{kind:'territory',states,reason:'explicit_title_territory'}}});
function search(job,zip){const p=point(zip),result=attachSearchDistance(job,{home_lat:p.lat,home_lng:p.lng});const d=result.job_lat==null?Infinity:distanceMiles(p.lat,p.lng,result.job_lat,result.job_lng);return {result,included:withinRadius(result,p,100,d)};}
test('substate coverage includes San Antonio but excludes Florida and Dallas without mileage',()=>{
 const job=territory('South Texas',['TX']);
 const inside=search(job,'78205');assert.equal(inside.included,true);
 assert.equal(inside.result.job_lat,null);assert.equal(inside.result.distance_miles,null);
 assert.equal(search(job,'34484').included,false);assert.equal(search(job,'75201').included,false);
 assert.equal(includesSearchArea(inside.result,point('34484')),false);
 const html=fs.readFileSync(__dirname+'/../public/rook-search.html','utf8');
 assert.match(html,/Territory includes your search area — exact distance unavailable\./);
 assert.match(html,/RookTerritoryLocation.withinRadius/);
});
test('multi-state coverage preserves compound states and rejects outside states',()=>{
 assert.deepEqual(new Set(stateCodesInText('North and South Carolina')),new Set(['NC','SC']));
 assert.deepEqual(new Set(stateCodesInText('Dakotas/Nebraska')),new Set(['ND','SD','NE']));
 const job=territory('North and South Carolina',['SC']);
 assert.equal(search(job,'28202').included,true);assert.equal(search(job,'34484').included,false);
 assert.equal(search(territory('Dakotas/Nebraska',['NE']),'58102').included,true);
 const explicit={...territory('Midwest',['IL']),description_text:'Territory includes: Illinois, Kansas, Missouri and Nebraska.'};
 assert.equal(search(explicit,'68102').included,true);assert.equal(search(explicit,'48201').included,false);
});
test('validated city points retain nearest-point mileage',()=>{
 const a=point('75201'),b=point('78205');
 const job={title_original:'Sales Representative',location_raw:'Dallas, TX | San Antonio, TX',location_evidence:{source_location:'Dallas, TX | San Antonio, TX',status:'validated',scope:{kind:'local'},locations:[{...a,state:'TX'},{...b,state:'TX'}]}};
 const {result,included}=search(job,'78205');assert.equal(included,true);assert.equal(result.distance_miles,0);assert.equal(result.job_lat,b.lat);assert.equal(result.territory_match,null);
});
test('generic remote and unknown substate evidence never grant geographic relevance',()=>{
 assert.equal(search({title_original:'Sales Representative',location_raw:'Remote'},'78205').included,false);
 assert.equal(search(territory('Southeast Detroit',['MI']),'30303').included,false);
 assert.equal(search(territory('Coastal Texas',['TX']),'78205').included,false);
});
