const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const token='a'.repeat(64);let current={token_hash:'hash',profile:{},user_id:null,alert_requested:false},calls=[],updates=[];
process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test';
const db={auth:{getUser:async token=>({data:{user:token==='valid'?{id:'existing',email_confirmed_at:'2026-01-01'}:null}})},
 rpc:async(name,args)=>{calls.push({name,args});return {};},from(table){return {select(){return this},eq(k,v){if(k==='unsubscribe_token')this.token=v;return this},gt(){return this},update(value){this.value=value;return this},maybeSingle:async()=>({data:current}),then(resolve,reject){updates.push({table,value:this.value,token:this.token});return Promise.resolve({}).then(resolve,reject);}}}};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
const app=express();app.use(express.json());app.use('/api/v7',require('./routes/onboardingV7'));
test('real routes enforce session/consent, preserve account state, and unsubscribe by opaque token',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/v7`;
 const send=(body,headers={})=>fetch(base+'/alerts',{method:'POST',headers:{'Content-Type':'application/json','X-ROOK-V7':token,...headers},body:JSON.stringify(body)});
 try {
  assert.equal((await send({email:'new@example.invalid',source:'onboarding'})).status,400);
  assert.equal((await send({email:'invalid',source:'exit',consent:true})).status,400);
  assert.equal((await send({email:'new@example.invalid',source:'exit',consent:true},{'X-ROOK-V7':'invalid'})).status,410);
  assert.equal((await send({email:' NEW@Example.invalid ',source:'onboarding',consent:true})).status,200);
  assert.equal(calls.length,1);assert.equal(calls[0].args.p_email,'new@example.invalid');assert.match(calls[0].args.p_unsubscribe,/^[a-f0-9]{64}$/);assert.equal(calls[0].args.p_hash,'hash');
  current.alert_requested=true;assert.equal((await send({email:'other@example.invalid',source:'exit',consent:true})).status,200);assert.equal(calls.length,1);
  current.alert_requested=false;assert.equal((await send({email:'other@example.invalid',source:'exit',consent:true},{Authorization:'Bearer valid'})).status,200);assert.equal(calls.length,1);
  current.user_id='existing';assert.equal((await send({email:'other@example.invalid',source:'exit',consent:true})).status,200);assert.equal(calls.length,1);
  let response=await fetch(base+'/alerts/unsubscribe?token='+token);assert.equal(response.status,200);assert.match(await response.text(),/method="post"/);assert.equal(updates.length,0);
  response=await fetch(base+'/alerts/unsubscribe',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token='+token});assert.equal(response.status,200);assert.equal(updates[0].value.digest_enabled,false);assert.equal(updates[0].token,token);assert.equal(updates[0].table,'pretrial_leads');
  assert.equal((await fetch(base+'/alerts/unsubscribe?token=bad')).status,400);
 } finally {server.close();server.closeAllConnections();}
});
