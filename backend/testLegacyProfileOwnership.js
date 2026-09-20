const assert = require('node:assert/strict');
const express = require('express');
process.env.SUPABASE_URL='https://test.invalid';
process.env.SUPABASE_ANON_KEY='test';
process.env.SUPABASE_SERVICE_ROLE_KEY='server';
const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
let writes=0, reads=0, authLookups=0;
const db={auth:{getUser:async token=>({data:{user:token==='valid'?{id:owner}:null}}),admin:{getUserById:async()=>{authLookups++;throw Error('must not access another account');}}},from(){return {upsert:async()=>{writes++;return {error:null};},select(){reads++;return this;},eq(){return this;},maybeSingle:async()=>({data:{resume_file_path:'private'}})}}};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
const app=express();app.use(express.json());app.use('/api',require('./routes/profile'));
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
try {
 for(const token of [null,'invalid','valid']){
  const headers=token?{Authorization:`Bearer ${token}`} : {};
  const expected=token==='valid'?403:401;
  const p=await fetch(base+'/api/profile/prefill',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({user_id:other,home_state:'FL'})});assert.equal(p.status,expected);
  const s=await fetch(base+'/api/onboarding/pre-verify-status/'+other,{headers});assert.equal(s.status,expected);
  const form=new FormData();form.append('user_id',other);form.append('resume',new Blob(['test']), 'test.pdf');
  const u=await fetch(base+'/api/onboarding/pre-verify-upload',{method:'POST',headers,body:form});assert.equal(u.status,expected);
 }
 assert.equal(writes,0);assert.equal(reads,0);assert.equal(authLookups,0);
 const own=await fetch(base+'/api/profile/prefill',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({user_id:owner,home_state:'FL',subscription_status:'active'})});assert.equal(own.status,200);assert.equal(writes,1);assert.equal(own.headers.get('cache-control'),'private, no-store');
 const status=await fetch(base+'/api/onboarding/pre-verify-status/'+owner,{headers:{Authorization:'Bearer valid'}});assert.equal(status.status,200);assert.equal(reads,1);
 console.log('PASS legacy ownership: anonymous/invalid/cross-account writes, uploads and status blocked before database access; owner prefill/status work.');
}finally{server.close();server.closeAllConnections();}
})().catch(e=>{console.error(e);process.exitCode=1;});
