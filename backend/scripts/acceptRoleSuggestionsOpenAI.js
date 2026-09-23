// Controlled role-suggestions acceptance only. No emails, purchases or real
// customer mutations. Synthetic app-only trial access expires within 10 minutes.
if (!process.argv.includes('--live')) throw Error('Requires --live');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createClient}=require('@supabase/supabase-js');
const {suggestRoles}=require('../ai/roleSuggestions');
const {structured}=require('../fixtures/resume/synthetic');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
let userId,openaiCalls=0,anthropicCalls=0;
function check(result){if(result.error)throw Error(result.error.message);return result.data;}
async function run(){
 delete process.env.ANTHROPIC_API_KEY;
 const originalFetch=global.fetch;
 global.fetch=(url,...args)=>{if(String(url).includes('anthropic.com')){anthropicCalls++;throw Error('Anthropic request forbidden');}if(String(url)==='https://api.openai.com/v1/responses')openaiCalls++;return originalFetch(url,...args)};
 const email=`rook-roles-accept-${crypto.randomUUID()}@example.com`,password=crypto.randomBytes(32).toString('hex');
 userId=check(await db.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name:'ROOK Synthetic Role Acceptance'}})).user.id;
 check(await db.from('candidate_profiles').upsert({user_id:userId,resume_structured:structured,subscription_status:'trialing',trial_ends_at:new Date(Date.now()+600000).toISOString()},{onConflict:'user_id'}));
 const stored=check(await db.from('candidate_profiles').select('resume_structured').eq('user_id',userId).single());
 const roles=await suggestRoles(stored.resume_structured);
 assert(roles.length>0&&roles.length<=6);assert(roles.every(r=>typeof r==='string'&&r.length<=120));
 // This synthetic input supports diagnostics sales to physicians and account
 // management, but no other industries, clinical credentials or people leadership.
 for(const role of roles)assert(!/veterinar|animal health|pharma|medical device|surgical|nurs|director|vice president|\bVP\b|regional.*manager|district.*manager|certified|engineer/i.test(role),`Unsupported target: ${role}`);
 assert.deepEqual(await suggestRoles({}),[]);
 check(await db.from('candidate_profiles').update({suggested_roles:roles}).eq('user_id',userId));
 const access=check(await auth.auth.signInWithPassword({email,password})).session.access_token;
 const response=await fetch('https://rookcareers.com/api/career-intelligence',{headers:{Authorization:`Bearer ${access}`}});assert.equal(response.status,200);
 const customer=await response.json();assert.equal(customer.has_resume,true);assert.deepEqual(customer.suggested_roles,roles);assert.deepEqual(customer.strengths,structured.performance_highlights);
 assert.equal(anthropicCalls,0);assert(openaiCalls>0&&openaiCalls<=2);
 console.log('ROLE_ACCEPTANCE_PASS',JSON.stringify({model:'gpt-4o-mini',profileRead:true,persisted:true,customerEndpoint:'/api/career-intelligence',customerStatus:response.status,suggested_roles:customer.suggested_roles,sourceFacts:stored.resume_structured,emptyProfile:[],openaiCalls,anthropicCalls}));
}
run().catch(error=>{console.error('ROLE_ACCEPTANCE_FAILED',error.message);process.exitCode=1}).finally(async()=>{
 if(userId){check(await db.auth.admin.deleteUser(userId));const remaining=check(await db.from('candidate_profiles').select('user_id').eq('user_id',userId).maybeSingle());assert.equal(remaining,null);console.log('ROLE_CLEANUP_PASS synthetic auth account and profile removed; no files created');}
}).catch(error=>{console.error('ROLE_CLEANUP_FAILED',error.message);process.exitCode=1});
