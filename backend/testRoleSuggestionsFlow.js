const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {structured,docx}=require('./fixtures/resume/synthetic');
process.env.SUPABASE_URL='https://example.invalid';process.env.SUPABASE_ANON_KEY='test';process.env.SUPABASE_SERVICE_ROLE_KEY='test';process.env.OPENAI_API_KEY='test';delete process.env.ANTHROPIC_API_KEY;
let profile={id:'test-role-profile',user_id:'test-role-user',subscription_status:'active'},mode='ok';
const roles=['Diagnostic Sales Representative','Physician Account Executive'];
const db={auth:{getUser:async()=>({data:{user:{id:'test-role-user'}}})},storage:{from:()=>({upload:async()=>({})})},from(table){return{upsert(value){Object.assign(profile,value);return this},select(){return this},eq(){return this},not(){return this},limit:async()=>({data:[]}),single:async()=>({data:{...profile}}),maybeSingle:async()=>({data:{...profile}})}}};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./ai/resumeAnalysis')]={exports:{analyzeResume:async()=>structured}};
require.cache[require.resolve('./ai/embeddings')]={exports:{generateEmbedding:async()=>[1,0]}};
require.cache[require.resolve('./scoring/precompute')]={exports:{scoreAndStoreForCandidate:async()=>({scoredCount:0})}};
const originalFetch=global.fetch;
global.fetch=async(url,opts)=>{if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,opts);assert.equal(url,'https://api.openai.com/v1/responses');return{ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:mode==='ok'?JSON.stringify({suggested_roles:roles}):'malformed'}]}]})}};
const app=express();app.use('/api',require('./routes/profile'));app.use('/api',require('./routes/careerIntelligence'));
test('existing upload persists role array and Career Intelligence returns it; failure preserves previous valid roles',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 const headers={Authorization:'Bearer test'};
 const upload=async()=>{const form=new FormData();form.append('resume',new Blob([await docx()],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'roles-test.docx');const r=await fetch(base+'/resume',{method:'POST',headers,body:form});assert.equal(r.status,200);assert.equal((await r.json()).analysis_status,'ok');};
 try{await upload();assert.deepEqual(profile.suggested_roles,roles);let r=await fetch(base+'/career-intelligence',{headers});assert.equal(r.status,200);assert.deepEqual((await r.json()).suggested_roles,roles);
 mode='bad';await upload();assert.deepEqual(profile.suggested_roles,roles);
 delete profile.suggested_roles;await upload();assert.equal(profile.suggested_roles,undefined);r=await fetch(base+'/career-intelligence',{headers});assert.deepEqual((await r.json()).suggested_roles,['Account Executive — Diagnostics']);
 }finally{server.close();server.closeAllConnections();global.fetch=originalFetch;}
});
