// V9 is an isolated acquisition funnel. V8 routes and session semantics stay unchanged.
const express = require('express');
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');
const {performance} = require('node:perf_hooks');
const {readCandidates,indexFor,startIndex} = require('../v8Matching');
const {rankPool} = require('../v7Matching');
const {prepareJob} = require('../v7Location');
const {notifyNewAccount} = require('../adminPush');

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
  return Object.fromEntries(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id']
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
function availabilityProfile(profile){return {...profile,territory_size_preferences:TERRITORIES,territory_size_preference:'local'};}
function geographicPool(pool,profile){
  return pool.map(job=>prepareJob(job,availabilityProfile(profile))).filter(job=>job&&
    !(job.geographic_eligibility?.kind==='local'&&Number(job.geographic_eligibility.distance_miles)>250));
}
function territoryPreference(job,profile){
  const selected=new Set(profile.territory_size_preferences||[]),kind=job.geographic_eligibility?.kind;
  if(kind==='remote_us')return selected.has('remote')?1:0;
  if(kind==='national_us')return selected.has('national')?1:0;
  if(kind==='territory')return selected.has('regional')||selected.has('national')?1:0;
  const distance=Number(job.distance_miles??job.geographic_eligibility?.distance_miles);
  if(Number.isFinite(distance)&&distance<=50)return selected.has('local')?1:0;
  if(Number.isFinite(distance)&&distance<=250)return selected.has('regional')?1:0;
  return 0;
}
async function calculate(profile,timing={}){
  const pool=await poolFor(profile,timing);
  const opportunities=geographicPool(pool,profile);
  const rankingProfile=availabilityProfile(scoringProfile(profile));
  const ranked=rankPool(opportunities,rankingProfile,[]).sort((a,b)=>
    territoryPreference(b,profile)-territoryPreference(a,profile)||
    (Number(b.match?.overall_score)||0)-(Number(a.match?.overall_score)||0)||String(a.id).localeCompare(String(b.id)));
  return {pool,opportunities,jobs:ranked.slice(0,32)};
}
function safeSummary(profile,result){
  return {profile:{home_location_label:profile.home_location_label,home_city:profile.home_city,home_state:profile.home_state,
    desired_industries:profile.desired_industries,total_sales_years:profile.total_sales_years,
    territory_size_preferences:profile.territory_size_preferences,subscription_status:profile.subscription_status},
    opportunity_count:result.opportunities.length,best_match_count:result.jobs.length};
}
function storedSummary(profile){
  const opportunityCount=Number(profile.v9_opportunity_count),bestMatchCount=Number(profile.v9_best_match_count);
  return Number.isInteger(opportunityCount)&&opportunityCount>=0&&Number.isInteger(bestMatchCount)&&bestMatchCount>=0
    ?safeSummary(profile,{opportunities:{length:opportunityCount},jobs:{length:bestMatchCount}}):null;
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
  const stage=String(req.body.stage||'location');
  if(stage!=='location')return res.status(400).json({error:'Invalid refinement stage.'});
  // ZIP establishes one stable availability pool. Later answers only rank it.
  const pool=await poolFor(profile,{validate_with_session:true});
  res.json({count:geographicPool(pool,profile).length,label:'opportunities available from your area'});
}));
router.post('/session',wrap(async(req,res)=>{
  const profile=profileFrom(req.body),timing={validate_with_session:true},started=performance.now();
  const calculated=await calculate(profile,timing);
  const token=crypto.randomBytes(32).toString('hex');
  const storedProfile={...profile,v9_opportunity_count:calculated.opportunities.length,v9_best_match_count:calculated.jobs.length};
  // This is only an onboarding-draft lifetime, not the trial clock. The
  // actual 24 hours starts in /claim after verified authentication succeeds.
  const record={token_hash:crypto.createHash('sha256').update(token).digest('hex'),profile:storedProfile,jobs:[],expires_at:new Date(Date.now()+7*24*60*60*1000).toISOString()};
  const saved=await db.from(table).insert(record);if(saved.error)throw saved.error;
  timing.total_ms=performance.now()-started;
  res.json({token,preview:safeSummary(profile,calculated),timing});
}));
router.get('/session',wrap(async(req,res)=>{
  const saved=await session(req);if(!saved)return res.status(410).json({error:'Your search expired. Please start again.'});
  const account=await user(req);if(saved.user_id&&saved.user_id!==account?.id)return res.status(403).json({error:'Sign in to your account.'});
  let profile={...saved.profile};
  if(account&&saved.user_id===account.id){const row=await db.from('candidate_profiles').select('*').eq('user_id',account.id).maybeSingle();if(row.error)throw row.error;profile={...profile,...row.data,...saved.profile};}
  const persisted=storedSummary(profile);if(persisted)return res.json(persisted);
  res.json(safeSummary(profile,await calculate(profile)));
}));
router.post('/claim',wrap(async(req,res)=>{
  let saved=await session(req);const account=await user(req);if(!saved||!account)return res.status(401).json({error:'Verify your email and sign in first.'});
  if(!saved.user_id){const result=await db.from(table).update({user_id:account.id}).eq('token_hash',saved.token_hash).is('user_id',null).select('*').maybeSingle();if(result.error)throw result.error;saved=result.data||await session(req);}
  if(saved.user_id!==account.id)return res.status(403).json({error:'These matches belong to another account.'});
  if(!saved.transferred_at){
    const existing=await db.from('candidate_profiles').select('utm_source').eq('user_id',account.id).maybeSingle();if(existing.error)throw existing.error;
    const profile={...saved.profile};delete profile.onboarding_version;delete profile.v9_opportunity_count;delete profile.v9_best_match_count;
    if(existing.data?.utm_source)for(const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id'])delete profile[key];
    const name=[account.user_metadata?.first_name,account.user_metadata?.last_name].filter(Boolean).join(' ');
    const written=await db.from('candidate_profiles').upsert({...profile,user_id:account.id,email:account.email,...(name?{name}:{})},{onConflict:'user_id'});if(written.error)throw written.error;
    const done=await db.from(table).update({transferred_at:new Date().toISOString()}).eq('token_hash',saved.token_hash).eq('user_id',account.id);if(done.error)throw done.error;
  }
  const marketingConsent=req.body?.marketing_consent===true;
  const activated=await db.rpc('activate_v9_trial',{p_user_id:account.id,p_marketing_consent:marketingConsent});
  if(activated.error)throw activated.error;
  const entitlement=Array.isArray(activated.data)?activated.data[0]:activated.data;
  if(!entitlement?.outcome)throw Error('Trial entitlement could not be confirmed.');
  if(entitlement.outcome==='started'){
    const profileResult=await db.from('candidate_profiles').select('name,utm_source,utm_medium,utm_campaign,utm_term,utm_content,utm_id').eq('user_id',account.id).maybeSingle();
    if(!profileResult.error){
      const p=profileResult.data||{};
      const event=await db.from('ad_conversion_events').insert({
        event_key:`v9_trial_started_${account.id}`,event_type:'trial_started',user_id:account.id,
        utm_source:p.utm_source||null,utm_medium:p.utm_medium||null,utm_campaign:p.utm_campaign||null,
        utm_term:p.utm_term||null,utm_content:p.utm_content||null,utm_id:p.utm_id||null,
        platform_inferred:p.utm_source||'unknown',occurred_at:entitlement.trial_started_at,
      });
      if(event.error&&event.error.code!=='23505')console.error('V9 trial analytics write failed:',event.error.message);
      if(!event.error){
        try{await notifyNewAccount({version:'V9',profile:p,occurredAt:entitlement.trial_started_at});}
        catch(_){console.warn('[admin push] account notification failed');}
      }
    }
  }
  res.json({ok:true,...entitlement});
}));

module.exports=router;
module.exports._test={INDUSTRIES,TERRITORIES,profileFrom,availabilityProfile,geographicPool,territoryPreference,storedSummary};
