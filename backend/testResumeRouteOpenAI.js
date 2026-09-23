const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {structured,docx}=require('./fixtures/resume/synthetic');
process.env.SUPABASE_URL='https://example.invalid';process.env.SUPABASE_ANON_KEY='test';process.env.SUPABASE_SERVICE_ROLE_KEY='test';process.env.OPENAI_API_KEY='test';delete process.env.ANTHROPIC_API_KEY;
let profile={id:'candidate-test',user_id:'test-user',home_lat:28.9,home_lng:-82,home_state:'FL',desired_industries:['Diagnostics'],territory_size_preferences:['local']},scored,mode='ok';
const db={auth:{getUser:async()=>({data:{user:{id:'test-user'}}})},storage:{from:()=>({upload:async()=>({})})},from:()=>({upsert(value){Object.assign(profile,value);return this},select(){return this},single:async()=>({data:{...profile}})})};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./ai/embeddings')]={exports:{generateEmbedding:async()=>[1,0]}};
require.cache[require.resolve('./scoring/precompute')]={exports:{scoreAndStoreForCandidate:async(_,p)=>{scored=p;return {scoredCount:1}}}};
const nativeFetch=global.fetch;
global.fetch=async(url,options)=>{
 if(String(url).startsWith('http://127.0.0.1:')) return nativeFetch(url,options);
 assert.equal(url,'https://api.openai.com/v1/responses');
 if(mode==='error') return {ok:false,status:401};
 return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:mode==='malformed'?'not json':JSON.stringify(structured)}]}]})};
};
const app=express();app.use('/api',require('./routes/profile'));
test('multipart upload → extraction → actual OpenAI client → persistence → V7 matches; failed uploads preserve valid facts',async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const upload=async(type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer)=>{
 const form=new FormData();form.append('resume',new Blob([buffer||await docx()],{type}),'synthetic.docx');const r=await fetch(`http://127.0.0.1:${server.address().port}/api/resume`,{method:'POST',headers:{Authorization:'Bearer test'},body:form});assert.equal(r.status,200);return r.json();};
 try {
  const result=await upload();assert.equal(result.analysis_status,'ok');assert.deepEqual(profile.resume_structured,structured);assert(profile.resume_text.includes('Example Diagnostics'));assert.deepEqual(scored.resume_structured,structured);
  const job={id:'job-test',title_original:'Physician Account Executive',company_name:'Synthetic Employer',location_raw:'Oxford, FL',state:'FL',job_lat:28.9,job_lng:-82,status:'active',moderation_status:'approved',industry:'Diagnostics',ai_analysis:{preferred_industries:['Diagnostics'],product_categories:['Diagnostics'],required_customer_types:['Physicians'],sales_motion:['Hunter'],seniority_level:'Account Executive',required_years_experience:5}};
  const q={select(){return this},eq(){return this},or(){return this},order(){return this},range:async()=>({data:[job]})};
  const matches=await require('./v7Matching').rank({from:()=>q},profile);assert.equal(matches.length,1);assert(matches[0].match.candidate_fit>0);assert(matches[0].match.reasons.some(r=>r.includes('Diagnostics')));
  for(mode of ['error','malformed']) {const failed=await upload();assert.equal(failed.analysis_status,'failed');assert.equal(failed.resume_structured,null);assert.deepEqual(profile.resume_structured,structured);}
  assert.equal((await upload('application/msword',Buffer.from('legacy'))).analysis_status,'no_text_extracted');
  assert.deepEqual(profile.resume_structured,structured);
 } finally {server.close();server.closeAllConnections();global.fetch=nativeFetch;}
});
