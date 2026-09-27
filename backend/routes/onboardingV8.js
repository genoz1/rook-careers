// V8 preview boundary. V7's routes, files and projection remain unchanged.
const express = require('express');
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');
const {rank} = require('../v7Matching');
const {project} = require('../pretrialProjection');
const {classify,normalizeSelection} = require('../../public/rook-job-classification');
const {hasFullAccess} = require('../matching');
const router = express.Router();
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
const calls = new Map();
const table='onboarding_v7_sessions';
const allowed=['Diagnostics','Medical Device','Pharmaceutical','Veterinary','Biotech/Life Sciences','Healthcare SaaS','Dental','Distribution','Capital Equipment'];
const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(()=>res.status(503).json({error:'Unable to load jobs. Please try again.'}));
router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  if(!db) return res.status(503).json({error:'Search is temporarily unavailable.'});
  const now=Date.now(), ip=req.ip;
  for(const [key,value] of calls) if(value.until<now) calls.delete(key);
  const v=calls.get(ip)||{count:0,until:now+60000};
  if(++v.count>35 || calls.size>10000) return res.status(429).json({error:'Please wait a minute and try again.'});
  calls.set(ip,v);next();
});
function validate(body) {
  const l=body?.location, industry=body?.industry;
  if(!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lng) || Math.abs(l.lat)>90 || Math.abs(l.lng)>180 ||
    !/^[A-Z]{2}$/.test(String(l.stateAbbr||l.state||'')) || !/^\d{5}$/.test(String(l.zip||''))) throw Error('Select a city, state or ZIP from the suggestions.');
  if(!allowed.includes(industry)) throw Error('Select an industry preference.');
  return {home_lat:l.lat,home_lng:l.lng,home_city:String(l.city||'').slice(0,150),
    home_state:String(l.stateAbbr||l.state).slice(0,2),home_zip:l.zip,
    home_location_label:String(l.label||'').slice(0,150),desired_industries:[industry],
    // An unanswered experience question is unknown, never invented.
    total_sales_years:null, territory_size_preferences:[], work_style:'field',onboarding_version:'v8',
    ...Object.fromEntries(['utm_source','utm_medium','utm_campaign','utm_term','utm_content']
      .filter(key=>typeof body.attribution?.[key]==='string').map(key=>[key,body.attribution[key].slice(0,200)]))};
}
function prioritize(jobs,industry) {
  const pref=normalizeSelection([industry])[0];
  return [...jobs].sort((a,b)=>{
    const fit=j=>classify(j).labels.includes(pref)?1:0;
    // Preference breaks close scores without displacing much stronger matches.
    const score=j=>(Number(j.match?.overall_score)||0)+fit(j)*12;
    return score(b)-score(a) || (b.match?.overall_score||0)-(a.match?.overall_score||0) || String(a.id).localeCompare(String(b.id));
  });
}
function reveal(job) {
  return {id:job.id,subscription_required:false,preview_revealed:true,
    title_original:job.title_original,company_name:job.company_name,
    location_raw:job.location_raw,city:job.city,state:job.state,
    distance_miles:job.distance_miles,remote_status:job.remote_status,
    employment_type:job.employment_type,date_posted:job.date_posted,first_seen_at:job.first_seen_at,
    industry_classification:classify(job),match:job.match,
    application_url:job.application_url,source_url:job.source_url};
}
async function session(req) {
  const token=req.get('X-ROOK-V7')||'';
  if(!/^[a-f0-9]{64}$/.test(token)) return null;
  const token_hash=crypto.createHash('sha256').update(token).digest('hex');
  const {data,error}=await db.from(table).select('*').eq('token_hash',token_hash).gt('expires_at',new Date().toISOString()).maybeSingle();
  if(error) throw error;
  return data?.profile?.onboarding_version==='v8'?data:null;
}
async function user(req) {
  const token=(req.get('Authorization')||'').replace(/^Bearer /,'');
  if(!token) return null;
  const {data,error}=await db.auth.getUser(token);
  return !error && data?.user?.email_confirmed_at?data.user:null;
}
router.post('/session',wrap(async(req,res)=>{
  let profile;
  try {profile=validate(req.body);} catch(e){return res.status(400).json({error:e.message});}
  const jobs=prioritize(await rank(db,profile,[]),profile.desired_industries[0]);
  const token=crypto.randomBytes(32).toString('hex');
  const {error}=await db.from(table).insert({token_hash:crypto.createHash('sha256').update(token).digest('hex'),profile,
    jobs,expires_at:new Date(Date.now()+24*60*60*1000).toISOString()});
  if(error) throw error;
  res.json({token});
}));
router.get('/session',wrap(async(req,res)=>{
  const s=await session(req);
  if(!s) return res.status(410).json({error:'Your search expired. Please start again.'});
  const u=await user(req);
  if(s.user_id && s.user_id!==u?.id) return res.status(403).json({error:'Sign in to your account.'});
  let profile={...s.profile};
  if(u && s.user_id===u.id) {
    const {data,error}=await db.from('candidate_profiles').select('*').eq('user_id',u.id).maybeSingle();
    if(error) throw error;
    profile={...profile,...data,...s.profile};
  }
  const unlocked=!!(s.user_id && u?.id===s.user_id && hasFullAccess(profile));
  // Re-rank even the initial paint: saved session snapshots may contain
  // coordinates scored before a location correction.
  const jobs=prioritize(await rank(db,profile,[]),profile.desired_industries[0]);
  res.json({profile:{home_location_label:profile.home_location_label,desired_industries:profile.desired_industries,
    subscription_status:profile.subscription_status},unlocked,count:jobs.length,
    jobs:jobs.map((j,i)=>unlocked?reveal(j):i<2?reveal(j):project(j,i,{dashboard:true}))});
}));
router.put('/preference',wrap(async(req,res)=>{
  const s=await session(req);
  if(!s) return res.status(410).json({error:'Your search expired.'});
  const u=await user(req);
  if(s.user_id && s.user_id!==u?.id) return res.status(403).json({error:'Sign in to your account.'});
  const industry=req.body?.industry;
  if(!allowed.includes(industry)) return res.status(400).json({error:'Select an industry preference.'});
  const profile={...s.profile,desired_industries:[industry]};
  const jobs=prioritize(await rank(db,profile,[]),industry);
  let query=db.from(table).update({profile,jobs}).eq('token_hash',s.token_hash);
  query=s.user_id?query.eq('user_id',s.user_id):query.is('user_id',null);
  const {data,error}=await query.select('token_hash').maybeSingle();
  if(error) throw error;
  if(!data) return res.status(409).json({error:'Your account changed. Please try again.'});
  res.json({ok:true});
}));
// V8's account handoff copies V7's ownership check and omits the V8-only
// marker before writing to candidate_profiles, whose schema is fixed.
router.post('/claim',wrap(async(req,res)=>{
  let s=await session(req),u=await user(req);
  if(!s||!u)return res.status(401).json({error:'Verify your email and sign in first.'});
  if(!s.user_id){
    const {data,error}=await db.from(table).update({user_id:u.id}).eq('token_hash',s.token_hash)
      .is('user_id',null).select('*').maybeSingle();
    if(error)throw error;
    s=data||await session(req);
  }
  if(s.user_id!==u.id)return res.status(403).json({error:'These matches belong to another account.'});
  if(!s.transferred_at){
    const {data:existing,error:readError}=await db.from('candidate_profiles').select('utm_source').eq('user_id',u.id).maybeSingle();
    if(readError)throw readError;
    const profile={...s.profile};delete profile.onboarding_version;
    if(existing?.utm_source)for(const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'])delete profile[key];
    const name=[u.user_metadata?.first_name,u.user_metadata?.last_name].filter(Boolean).join(' ');
    const {error}=await db.from('candidate_profiles').upsert({...profile,user_id:u.id,...(name?{name}:{})},{onConflict:'user_id'});
    if(error)throw error;
    const saved=await db.from(table).update({transferred_at:new Date().toISOString()}).eq('token_hash',s.token_hash).eq('user_id',u.id);
    if(saved.error)throw saved.error;
  }
  res.json({ok:true});
}));
module.exports=router;
module.exports._test={validate,prioritize,reveal};
