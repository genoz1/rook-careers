const assert=require('node:assert/strict');
const express=require('express');
const ga4=require('./ga4');
let periods=[];
ga4.getReport=async period=>{periods.push(period);return {ok:false,error:'GA4 simulated failure'};};
process.env.AD_MANAGER_TEST_TOKEN='local-test-only';
delete process.env.SUPABASE_URL;
const app=express();app.use('/api',require('../routes/admin'));
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/admin/admanager/ga4`;
 try{
  for(const suffix of ['', '?token=wrong'])assert.equal((await fetch(base+suffix)).status,401);
  assert.equal(periods.length,0);
  assert.equal((await fetch(base+'?token=local-test-only&period=invalid')).status,400);
  assert.equal(periods.length,0);
  for(const period of ['today','yesterday','7d']){
   const response=await fetch(base+'?token=local-test-only&period='+period);
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   assert.deepEqual(await response.json(),{ok:false,error:'GA4 simulated failure'});
  }
  assert.deepEqual(periods,['today','yesterday','7d']);
  delete process.env.AD_MANAGER_TEST_TOKEN;
  assert.equal((await fetch(base+'?token=local-test-only')).status,401);
  console.log('GA4 route authorization, period validation, no-store and isolated failure response passed');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
