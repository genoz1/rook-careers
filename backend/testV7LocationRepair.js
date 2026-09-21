const assert=require('node:assert/strict');const {repairV7Locations}=require('./scripts/repairV7Locations');
function fakeDb(rows){return {from(){let filters=[],patch=null;const q={select(){return q;},update(p){patch=p;return q;},eq(k,v){filters.push(r=>typeof r[k]==='object'?JSON.stringify(r[k])===v:r[k]===v);return q;},is(k,v){filters.push(r=>r[k]===v);return q;},then(resolve){const matching=rows.filter(r=>filters.every(f=>f(r)));if(patch)matching.forEach(r=>Object.assign(r,structuredClone(patch)));return Promise.resolve({data:matching.map(r=>({id:r.id}))}).then(resolve);}};return q;}};}
(async()=>{const original={job_lat:null,job_lng:null,state:null,location_evidence:{status:'unresolved'}},patch={job_lat:42.36,job_lng:-71.06,state:'MA',location_evidence:{status:'validated'}};
const entry={id:'11111111-1111-1111-1111-111111111111',location_raw:'Boston, MA',title_original:'Account Executive',original,patch};const row={...structuredClone(original),id:entry.id,location_raw:entry.location_raw,title_original:entry.title_original,status:'active',moderation_status:'approved'};const db=fakeDb([row]);
assert.deepEqual(await repairV7Locations(db,[entry]),{ready:1,updated:0,skipped:0});assert.equal(row.job_lat,null);
assert.equal((await repairV7Locations(db,[entry],{apply:true})).updated,1);assert.equal(row.job_lat,42.36);
assert.equal((await repairV7Locations(db,[entry],{apply:true})).skipped,1);
assert.equal((await repairV7Locations(db,[entry],{apply:true,rollback:true})).updated,1);assert.equal(row.job_lat,null);
row.location_raw='Miami, FL';assert.equal((await repairV7Locations(db,[entry],{apply:true})).skipped,1);
row.location_raw=entry.location_raw;row.location_evidence={status:'new_ingestion'};assert.equal((await repairV7Locations(db,[entry],{apply:true})).skipped,1);
console.log('PASS: read-only default, guarded apply, repeat-run idempotency, rollback, changed source/evidence protection.');})();
