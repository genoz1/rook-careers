const {test}=require('node:test');const assert=require('node:assert/strict');
const {listingData,fetchKulaJobs}=require('./adapters/kula');
const row={id:123,title:'Territory Sales Manager',listed:true,is_confidential:false};
const listing='<script>self.__next_f.push('+JSON.stringify([1,'0:'+JSON.stringify({jobs:[row]})])+')</script>';
test('Kula parses public data without executing scripts and rejects absent listings',()=>{
 assert.deepEqual(listingData(listing),[row]);assert.throws(()=>listingData('<script>throw Error("x")</script>'),/unavailable/);
});
test('Kula mismatched detail cannot create a job or authorize closures',async()=>{
 const old=global.fetch;global.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>String(url).endsWith('/123')?'<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title:'Different role',description:'text'})+'</script>':listing});
 try{let jobs=await fetchKulaJobs('company');assert.equal(jobs.length,0);assert.equal(jobs.incompleteSnapshot,true)}finally{global.fetch=old}
});
