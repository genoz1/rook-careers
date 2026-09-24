// Explicit, controlled production acceptance. Synthetic account only; no emails,
// purchases or entitlement changes. Always removes its own test files/account.
if (!process.argv.includes('--live')) throw Error('Requires --live');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createClient}=require('@supabase/supabase-js');
const {text,docx}=require('../fixtures/resume/synthetic');
const pdfMode=process.argv.includes('--pdf');
const {pdf}=require('../fixtures/resume/realisticPdf');
const {analyzeResume}=require('../ai/resumeAnalysis');
const {rank}=require('../v7Matching');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
const base='https://rookcareers.com';let userId,sessionToken,uploadedPath;
function check(result){if(result.error)throw Error(result.error.message);return result.data;}
async function run(){
 delete process.env.ANTHROPIC_API_KEY;
 const originalFetch=global.fetch;
 global.fetch=(url,...args)=>{assert(!String(url).includes('anthropic.com'),'Anthropic request forbidden');return originalFetch(url,...args)};
 if(!pdfMode){
 const facts=await analyzeResume(text);
 assert.equal(facts.employers.length,2);assert.equal(facts.employers[0].company,'Example Diagnostics');assert.equal(facts.employers[0].title,'Account Executive');assert.equal(facts.employers[0].start,'January 2020');assert.equal(facts.employers[0].end,'December 2025');assert.equal(facts.employers[1].start,null);assert.equal(facts.employers[1].achievements,null);assert.equal(facts.management_experience,false);assert.equal(facts.total_sales_years,6);assert.deepEqual(facts.certifications,[]);assert.deepEqual(facts.clinical_technical_experience,[]);
 console.log('MODEL_FACTS',JSON.stringify(facts));
 const partial=await analyzeResume('Sam Sample\nVeterinary Technician — Example Animal Clinic\nAssisted veterinarians in clinical examinations of dogs and cats.\nNo employment dates supplied.');
 assert.equal(partial.total_sales_years,null);assert.equal(partial.management_experience,false);assert.equal(partial.employers[0].start,null);assert.deepEqual(partial.certifications,[]);assert.deepEqual(partial.sales_motion,[]);console.log('PARTIAL_FACTS',JSON.stringify(partial));
 }
 const email=`rook-resume-accept-${crypto.randomUUID()}@example.com`,password=crypto.randomBytes(32).toString('hex');
 userId=check(await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:'ROOK Synthetic Resume Acceptance'}})).user.id;
 const access=check(await auth.auth.signInWithPassword({email,password})).session.access_token;
 async function request(path,opts={}){const response=await fetch(base+path,{...opts,headers:{Authorization:`Bearer ${access}`,...(sessionToken?{'X-ROOK-V7':sessionToken}:{}),...opts.headers}});const data=await response.json();if(!response.ok)throw Error(`${path} HTTP ${response.status}: ${data.error}`);return data;}
 const s=await request('/api/v7/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:{lat:28.9,lng:-82,city:'Oxford',state:'FL',zip:'34484',label:'Oxford, FL'},industry:'Diagnostics',years:6,territories:['local']})});
 sessionToken=s.token;assert(sessionToken);
 const fileName=pdfMode?'synthetic-acceptance.pdf':'synthetic-acceptance.docx';
 const fileType=pdfMode?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
 const form=new FormData();form.append('resume',new Blob([pdfMode?pdf():await docx()],{type:fileType}),fileName);
 await request('/api/v7/resume',{method:'POST',body:form});await request('/api/v7/claim',{method:'POST'});
 const staged=await fetch(base+'/api/v7/resume',{headers:{Authorization:`Bearer ${access}`,'X-ROOK-V7':sessionToken}});assert(staged.ok);
 const stagedForm=new FormData();stagedForm.append('resume',new Blob([await staged.arrayBuffer()],{type:staged.headers.get('X-Resume-Type')}),fileName);
 const result=await request('/api/resume',{method:'POST',body:stagedForm});uploadedPath=result.path;assert.equal(result.analysis_status,'ok');
 const stored=check(await db.from('candidate_profiles').select('*').eq('user_id',userId).single());assert(stored.resume_text.includes('Example Diagnostics'));assert.deepEqual(stored.resume_structured,result.resume_structured);assert.equal(stored.resume_structured.employers[0].company,'Example Diagnostics');assert.equal(stored.resume_structured.total_sales_years,6);assert.equal(stored.resume_structured.management_experience,false);assert.deepEqual(stored.resume_structured.certifications,[]);
 await request('/api/v7/resume-complete',{method:'POST'});
 const snapshot=await request('/api/v7/session');assert.deepEqual(snapshot.profile.resume_structured,stored.resume_structured);assert(snapshot.jobs.length>0);
 const matches=await rank(db,snapshot.profile);assert(matches.length>0);assert(matches.some(j=>j.match.candidate_fit!=null));assert(matches.some(j=>j.match.reasons.some(r=>/Diagnostics|Physicians|product experience/.test(r))));
 console.log('ACCEPTANCE_PASS',JSON.stringify({model:'gpt-4o-mini',upload:true,extraction:true,persistence:true,profileToV7:true,matches:snapshot.jobs.length,candidateFitMatches:matches.filter(j=>j.match.candidate_fit!=null).length,pdf:pdfMode,storedFacts:stored.resume_structured}));
 if(pdfMode){
  assert(stored.resume_text.includes('company’s'));assert(/long-\s*\nterm/.test(stored.resume_text));
  const achievements=stored.resume_structured.employers.map(e=>e.achievements||'').join('\n');
  assert(achievements.includes('103.7%'));assert(achievements.includes('$125,000+'));
  const failedForm=new FormData();failedForm.append('resume',new Blob([Buffer.from('%PDF-1.4\ninvalid test PDF')],{type:'application/pdf'}),'synthetic-invalid.pdf');
  const failed=await request('/api/resume',{method:'POST',body:failedForm});assert.equal(failed.analysis_status,'no_text_extracted');
  const retained=check(await db.from('candidate_profiles').select('resume_structured').eq('user_id',userId).single());assert.deepEqual(retained.resume_structured,stored.resume_structured);
  check(await db.storage.from('resumes').download(uploadedPath));
  console.log('PRESERVATION_PASS prior structured profile and valid resume file survive failed PDF analysis');
 }
 // Wait for only this candidate's background scoring before removing test data.
 for(let n=0;n<20;n++){const p=check(await db.from('candidate_profiles').select('scoring_version').eq('user_id',userId).single());if(p.scoring_version)break;await new Promise(r=>setTimeout(r,1000));}
}
run().catch(error=>{console.error('ACCEPTANCE_FAILED',error.message);process.exitCode=1}).finally(async()=>{
 if(userId){
  const files=check(await db.storage.from('resumes').list(userId));if(files.length)check(await db.storage.from('resumes').remove(files.map(f=>`${userId}/${f.name}`)));
  if(sessionToken){const hash=crypto.createHash('sha256').update(sessionToken).digest('hex');const staged=check(await db.storage.from('onboarding-v7-private').list(hash));if(staged.length)check(await db.storage.from('onboarding-v7-private').remove(staged.map(f=>`${hash}/${f.name}`)));check(await db.from('onboarding_v7_sessions').delete().eq('token_hash',hash));}
  check(await db.auth.admin.deleteUser(userId));
  assert.equal(check(await db.storage.from('resumes').list(userId)).length,0);
  assert.equal(check(await db.from('candidate_profiles').select('id').eq('user_id',userId)).length,0);
  if(sessionToken){const hash=crypto.createHash('sha256').update(sessionToken).digest('hex');assert.equal(check(await db.storage.from('onboarding-v7-private').list(hash)).length,0);assert.equal(check(await db.from('onboarding_v7_sessions').select('token_hash').eq('token_hash',hash)).length,0);}
  const removed=await db.auth.admin.getUserById(userId);assert(!removed.data.user);
  console.log('CLEANUP_PASS verified synthetic account, profile, session and files removed');
 }
}).catch(error=>{console.error('CLEANUP_FAILED',error.message);process.exitCode=1});
