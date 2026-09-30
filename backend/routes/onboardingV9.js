// V9 is an isolated paid-Meta mobile funnel. V8 routes and session semantics stay unchanged.
const express = require('express');
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');
const {performance} = require('node:perf_hooks');
const {rank,readCandidates,indexFor,startIndex} = require('../v8Matching');
const {rankPool} = require('../v7Matching');
const {prepareJob} = require('../v7Location');
const {project} = require('../pretrialProjection');
const {classify,normalizeSelection,matches} = require('../../public/rook-job-classification');
const {hasFullAccess} = require('../matching');

const router=express.Router();
const db=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
if(db)startIndex(db);
const table='onboarding_v7_sessions';
const INDUSTRIES=['Diagnostics','Medical Device','Pharmaceutical','Veterinary','Biotech/Life Sciences','Healthcare SaaS','Dental','Distribution','Capital Equipment'];
const TERRITORIES=['local','regional','national','remote'];
const calls=new Map();
const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(error=>{
  console.error('V9 route failed:',error.message);
  res.status(503).json({error:'Unable to update your matches. Please try again.'});
});

router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  if(!db)return res.status(503).json({error:'Search is temporarily unavailable.'});
  const now=Date.now(),entry=calls.get(req.ip)||{count:0,until:now+60000};
  for(const [key,value] of calls)if(value.until<now)calls.delete(key);
  if(++entry.count>45||calls.size>10000)return res.status(429).json({error:'Please wait a minute and try again.'});
  calls.set(req.ip,entry);next();
});

function short(value,max=150){return typeof value==='string'?value.trim().slice(0,max):'';}
function validateLocation(location){
  if(!location||!Number.isFinite(location.lat)||!Number.isFinite(location.lng)||Math.abs(location.lat)>90||Math.abs(location.lng)>180||
    !/^[A-Z]{2}$/.test(String(location.stateAbbr||location.state||''))||!/^\d{5}$/.test(String(location.zip||'')))
    throw Error('Choose a U.S. city, state or ZIP from the suggestions.');
  return location;
}
function validateIndustries(values){
  const selected=[...new Set(Array.isArray(values)?values:[])];
  if(!selected.length||selected.some(value=>!INDUSTRIES.includes(value)))throw Error('Select at least one industry preference.');
  return selected;
}
function validateYears(value){
  const years=Number(value);
  if(!Number.isFinite(years)||years<0||years>60)throw Error('Select your sales experience.');
  return years;
}
function validateTerritories(values){
  const selected=[...new Set(Array.isArray(values)?values:[])];
  if(!selected.length||selected.some(value=>!TERRITORIES.includes(value)))throw Error('Select at least one territory preference.');
  return selected;
}
function attribution(body){
  return Object.fromEntries(['utm_source','utm_medium','utm_campaign','utm_term','utm_content']
    .filter(key=>typeof body?.attribution?.[key]==='string'&&body.attribution[key].trim())
    .map(key=>[key,body.attribution[key].trim().slice(0,200)]));
}
function profileFrom(body,{partial=false}={}){
  const location=validateLocation(body.location);
  const industries=partial&&(!body.industries||!body.industries.length)?[]:validateIndustries(body.industries);
  const years=partial&&body.years==null?null:validateYears(body.years);
  const territories=partial&&(!body.territories||!body.territories.length)?TERRITORIES:validateTerritories(body.territories);
  return {...attribution(body),home_lat:location.lat,home_lng:location.lng,home_city:short(location.city),
    home_state:short(location.stateAbbr||location.state,2),home_zip:short(location.zip,5),home_location_label:short(location.label),
    desired_industries:industries,total_sales_years:years,territory_size_preferences:territories,
    territory_size_preference:territories[0],work_style:territories.length===1&&territories[0]==='remote'?'remote':'field',onboarding_version:'v9'};
}
function scoringProfile(profile){
  return profile.total_sales_years==null?profile:{...profile,resume_structured:{total_sales_years:profile.total_sales_years}};
}
async function poolFor(profile,timing={}){
  const local=await indexFor(db).current(timing);
  return local||await readCandidates(db,{...profile,territory_size_preferences:TERRITORIES},timing);
}
function mergeFloor(preferred,widened,target=32){
  const seen=new Set(),jobs=[];
  for(const job of [...preferred,...widened])if(!seen.has(job.id)){seen.add(job.id);jobs.push(job);}
  const preferredCount=preferred.length;
  return {jobs:jobs.slice(0,target),widened:preferredCount<Math.min(target,jobs.length),preferredCount};
}
async function calculate(profile,timing={}){
  const pool=await poolFor(profile,timing);
  const broadProfile={...profile,territory_size_preferences:TERRITORIES,territory_size_preference:'local'};
  const opportunities=pool.map(job=>prepareJob(job,broadProfile)).filter(Boolean);
  const industryAligned=profile.desired_industries.length?opportunities.filter(job=>matches(job,profile.desired_industries)):opportunities;
  const preferred=rankPool(pool,scoringProfile(profile),[]);
  const widened=rankPool(pool,scoringProfile(broadProfile),[]);
  const floor=mergeFloor(preferred,widened,32);
  return {pool,opportunities,industryAligned,preferred,widened,...floor};
}
function prioritize(jobs,industries){
  const selected=normalizeSelection(industries);
  return [...jobs].sort((a,b)=>{
    const ai=matches(a,selected)?1:0,bi=matches(b,selected)?1:0;
    return bi-ai-(Number(a.match?.overall_score)||0)+(Number(b.match?.overall_score)||0)||String(a.id).localeCompare(String(b.id));
  });
}
function reveal(job){
  return {id:job.id,subscription_required:false,preview_revealed:true,title_original:job.title_original,
    company_name:job.company_name,location_raw:job.location_raw,city:job.city,state:job.state,distance_miles:job.distance_miles,
    remote_status:job.remote_status,employment_type:job.employment_type,date_posted:job.date_posted,first_seen_at:job.first_seen_at,
    industry_classification:classify(job),match:job.match,application_url:job.application_url,source_url:job.source_url};
}
function safePreview(profile,jobs,unlocked,widened,preferredCount,opportunityCount){
  return {profile:{home_location_label:profile.home_location_label,desired_industries:profile.desired_industries,
    total_sales_years:profile.total_sales_years,territory_size_preferences:profile.territory_size_preferences,
    subscription_status:profile.subscription_status},unlocked,widened,preferred_count:preferredCount,
    opportunity_count:opportunityCount,best_match_count:jobs.length,
    jobs:jobs.map((job,index)=>unlocked?reveal(job):index<2?reveal(job):project(job,index,{dashboard:true}))};
}
async function details(jobs,unlocked=false){
  const ids=jobs.slice(0,unlocked?jobs.length:2).map(job=>job.id);
  if(!ids.length)return jobs;
  const result=await db.from('jobs').select('id,company_name,city,application_url,source_url').eq('status','active')
    .eq('moderation_status','approved').in('id',ids);
  if(result.error||result.data?.length!==ids.length)throw Error('Preview details changed; retry search.');
  const map=new Map(result.data.map(job=>[job.id,job]));
  return jobs.map(job=>map.has(job.id)?{...job,...map.get(job.id)}:job);
}
async function session(req){
  const token=req.get('X-ROOK-V9')||'';
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const result=await db.from(table).select('*').eq('token_hash',tokenHash).gt('expires_at',new Date().toISOString()).maybeSingle();
  if(result.error)throw result.error;
  return result.data?.profile?.onboarding_version==='v9'?result.data:null;
}
async function user(req){
  const token=(req.get('Authorization')||'').replace(/^Bearer /,'');if(!token)return null;
  const result=await db.auth.getUser(token);return !result.error&&result.data?.user?.email_confirmed_at?result.data.user:null;
}

router.get('/pool',wrap(async(req,res)=>{
  const result=await db.from('jobs').select('id',{count:'exact',head:true}).eq('status','active').eq('moderation_status','approved');
  if(result.error)throw result.error;
  res.json({opportunities:result.count||0,industry_taxonomy:INDUSTRIES});
}));
router.post('/refine',wrap(async(req,res)=>{
  const profile=profileFrom(req.body,{partial:true});
  const result=await calculate(profile);
  const stage=String(req.body.stage||'location');
  let count=result.opportunities.length,label='opportunities in your search area';
  if(['industry','experience','territory'].includes(stage)){
    count=Math.min(result.opportunities.length,Math.max(Math.min(32,result.opportunities.length),result.industryAligned.length));label='opportunities aligned with your industry preferences';
  }
  if(['experience','territory'].includes(stage)){
    count=Math.min(result.opportunities.length,Math.max(Math.min(32,result.opportunities.length),Math.min(result.industryAligned.length,result.preferred.length)));label='best available matches';
  }
  if(stage==='territory'){count=result.jobs.length;label=result.widened?'best available matches':'best matches for your preferences';}
  res.json({count,opportunities:result.opportunities.length,label,widened:stage==='territory'&&result.widened,preferred_count:result.preferredCount});
}));
router.post('/session',wrap(async(req,res)=>{
  const profile=profileFrom(req.body),timing={validate_with_session:true},started=performance.now();
  const calculated=await calculate(profile,timing);
  let jobs=prioritize(calculated.jobs,profile.desired_industries);
  const token=crypto.randomBytes(32).toString('hex');
  const record={token_hash:crypto.createHash('sha256').update(token).digest('hex'),profile,jobs:[],expires_at:new Date(Date.now()+24*60*60*1000).toISOString()};
  const saved=await db.from(table).insert(record);if(saved.error)throw saved.error;
  jobs=await details(jobs,false);
  timing.total_ms=performance.now()-started;
  res.json({token,preview:safePreview(profile,jobs,false,calculated.widened,calculated.preferredCount,calculated.opportunities.length),timing});
}));
router.get('/session',wrap(async(req,res)=>{
  const saved=await session(req);if(!saved)return res.status(410).json({error:'Your search expired. Please start again.'});
  const account=await user(req);if(saved.user_id&&saved.user_id!==account?.id)return res.status(403).json({error:'Sign in to your account.'});
  let profile={...saved.profile};
  if(account&&saved.user_id===account.id){const row=await db.from('candidate_profiles').select('*').eq('user_id',account.id).maybeSingle();if(row.error)throw row.error;profile={...profile,...row.data,...saved.profile};}
  const calculated=await calculate(profile);let jobs=prioritize(calculated.jobs,profile.desired_industries);
  const unlocked=!!(saved.user_id&&account?.id===saved.user_id&&hasFullAccess(profile));jobs=await details(jobs,unlocked);
  res.json(safePreview(profile,jobs,unlocked,calculated.widened,calculated.preferredCount,calculated.opportunities.length));
}));
router.post('/claim',wrap(async(req,res)=>{
  let saved=await session(req);const account=await user(req);if(!saved||!account)return res.status(401).json({error:'Verify your email and sign in first.'});
  if(!saved.user_id){const result=await db.from(table).update({user_id:account.id}).eq('token_hash',saved.token_hash).is('user_id',null).select('*').maybeSingle();if(result.error)throw result.error;saved=result.data||await session(req);}
  if(saved.user_id!==account.id)return res.status(403).json({error:'These matches belong to another account.'});
  if(!saved.transferred_at){
    const existing=await db.from('candidate_profiles').select('utm_source').eq('user_id',account.id).maybeSingle();if(existing.error)throw existing.error;
    const profile={...saved.profile};delete profile.onboarding_version;
    if(existing.data?.utm_source)for(const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'])delete profile[key];
    const name=[account.user_metadata?.first_name,account.user_metadata?.last_name].filter(Boolean).join(' ');
    const written=await db.from('candidate_profiles').upsert({...profile,user_id:account.id,email:account.email,...(name?{name}:{})},{onConflict:'user_id'});if(written.error)throw written.error;
    const done=await db.from(table).update({transferred_at:new Date().toISOString()}).eq('token_hash',saved.token_hash).eq('user_id',account.id);if(done.error)throw done.error;
  }
  res.json({ok:true});
}));

module.exports=router;
module.exports._test={INDUSTRIES,TERRITORIES,profileFrom,mergeFloor,prioritize};
