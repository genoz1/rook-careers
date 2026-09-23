const {test}=require('node:test'),assert=require('node:assert/strict');
const {callOpenAIForJSON}=require('./ai/openaiJson'),{RESUME_SCHEMA}=require('./ai/resumeSchema'),{analyzeResume}=require('./ai/resumeAnalysis');
const {text,structured,docx}=require('./fixtures/resume/synthetic');
const {extractResumeText}=require('./resumeParser');
const reply=(value=structured)=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]})});
process.env.OPENAI_API_KEY='test-only';delete process.env.ANTHROPIC_API_KEY;
const call=options=>callOpenAIForJSON('facts only',text,6000,{schema:RESUME_SCHEMA,...options});
test('OpenAI strict schema, existing key and economical model without Anthropic',async()=>{
 const value=await call({fetchImpl:async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(opts.body);assert.equal(body.model,'gpt-4o-mini');assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.deepEqual(body.text.format.schema,RESUME_SCHEMA);return reply();}});assert.deepEqual(value,structured);
});
test('real DOCX extraction, partial fields and unsupported/empty extraction',async()=>{
 const extracted=await extractResumeText(await docx(),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert(extracted.includes('Example Diagnostics'));
 const result=await analyzeResume(extracted,{callAI:async()=>structured});assert.equal(result.employers[1].start,null);assert.equal(result.employers[1].achievements,null);
 assert.equal(await extractResumeText(Buffer.from('legacy'),'application/msword'),null);
 assert.equal(await extractResumeText(await docx(''),'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),null);
 await assert.rejects(analyzeResume('short'),/short/);await assert.rejects(analyzeResume('a'.repeat(60001)),/too long/);
});
test('malformed, missing fields, wrong types, incomplete and refusal fail closed',async()=>{
 for(const value of [{}, {...structured,total_sales_years:'six'}, {...structured,total_sales_years:-1}, {...structured,unexpected:'fact'}]) await assert.rejects(call({fetchImpl:async()=>reply(value)}),/Invalid/);
 for(const data of [{status:'incomplete'}, {status:'completed',output:[{content:[{type:'refusal'}]}]}, {status:'completed',output:[{content:[{type:'output_text',text:'```json {}'}]}]}]) await assert.rejects(call({fetchImpl:async()=>({ok:true,json:async()=>data})}));
});
test('literal hallucinations and missing fields are rejected before persistence',async()=>{
 await assert.rejects(analyzeResume(text,{callAI:async()=>({...structured,employers:[{...structured.employers[0],company:'Invented Employer'}]})}),/unsupported/);
 await assert.rejects(analyzeResume(text,{callAI:async()=>({...structured,certifications:['Invented credential']})}),/unsupported/);
 await assert.rejects(analyzeResume(text,{callAI:async()=>({employers:[]})}),/Invalid/);
});
test('bounded transient retries, timeout and permanent API error',async()=>{
 let calls=0;await call({fetchImpl:async()=>++calls===1?{ok:false,status:503}:reply()});assert.equal(calls,2);
 calls=0;await assert.rejects(call({fetchImpl:async()=>{calls++;return {ok:false,status:401}}}),/401/);assert.equal(calls,1);
 calls=0;await assert.rejects(call({timeoutMs:5,fetchImpl:async(_,opts)=>{calls++;return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'}))))}}),/timed out/);assert.equal(calls,2);
 calls=0;await assert.rejects(call({fetchImpl:async()=>{calls++;throw TypeError('offline')}}),/offline/);assert.equal(calls,2);
});
