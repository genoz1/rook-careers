const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fetchAdpJobs}=require('./adapters/adp');
const employer={id:'e',company_name:'Employer',ats_identifier:'3b6256c1-2a46-4436-9cdb-bc5511fc6ab2'};
const detail={itemID:'abc_1',requisitionTitle:'Territory Sales Manager',requisitionDescription:'<p>Sell diagnostics</p>',customFieldGroup:{stringFields:[{nameCode:{codeValue:'ExternalJobID'},stringValue:'123'}]},requisitionLocations:[{nameCode:{shortName:'Boston, MA, US'}}]};
test('ADP public feed and detail use stable IDs and retain source location',async()=>{
 const original=global.fetch; const calls=[];
 global.fetch=async url=>{const u=new URL(url);calls.push(u);return {ok:true,json:async()=>u.pathname.endsWith('/abc_1')?detail:{jobRequisitions:[detail],meta:{totalNumber:1}}}};
 try{const jobs=await fetchAdpJobs(employer);assert.equal(jobs.length,1);assert.equal(jobs[0].location_raw,'Boston, MA, US');assert.match(jobs[0].application_url,/jobId=123/);assert.equal(jobs[0].description_text,'Sell diagnostics');assert.equal(calls[0].searchParams.get('$skip'),'0');assert.equal(jobs.incompleteSnapshot,false)}finally{global.fetch=original}
});
test('ADP malformed HTML fails visibly and unavailable details forbid closures',async()=>{
 const original=global.fetch;
 try{
 global.fetch=async()=>({ok:true,json:async()=>{throw Error('Unexpected HTML')}});
 await assert.rejects(fetchAdpJobs(employer),/Unexpected HTML/);
 global.fetch=async url=>({ok:true,json:async()=>String(url).includes('/abc_1')?{...detail,itemID:'other'}:{jobRequisitions:[detail],meta:{totalNumber:1}}});
 const jobs=await fetchAdpJobs(employer);assert.equal(jobs.length,0);assert.equal(jobs.incompleteSnapshot,true);
 }finally{global.fetch=original}
});
