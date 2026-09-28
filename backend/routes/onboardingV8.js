// V8 preview boundary. V7's routes, files and projection remain unchanged.
const express = require('express');
const crypto = require('crypto');
const {createClient} = require('@supabase/supabase-js');
const {rank,startIndex,indexFor} = require('../v8Matching');
const {performance} = require('node:perf_hooks');
const {project} = require('../pretrialProjection');
const {classify,normalizeSelection} = require('../../public/rook-job-classification');
const {hasFullAccess} = require('../matching');
const router = express.Router();
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
if(db)startIndex(db);
const calls = new Map();
const table='onboarding_v7_sessions';
const allowed=['Diagnostics','Medical Device','Pharmaceutical','Veterinary','Biotech/Life Sciences','Healthcare SaaS','Dental','Distribution','Capital Equipment'];
const wrap=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(error=>{
  // Keep the error details in server logs; the browser receives a stable,
  // non-sensitive category and a correlation ID only.
  const code=String(error?.code||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,40);
  const message=String(error?.message||'Unexpected error').replace(/\S+@\S+/g,'[email]')
    .replace(/(password|token|secret|key)\s*[:=]\s*\S+/gi,'$1=[redacted]').slice(0,400);
  console.error('V8 request failed',{request_id:req.v8RequestId,path:req.path,error_name:error?.name||'Error',code,message});
  res.status(503).json({error:'Unable to load jobs. Please try again.',request_id:req.v8RequestId});
});
router.use((req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  req.v8RequestId=/^[a-f0-9-]{36}$/i.test(req.get('X-ROOK-Request-ID')||'')
    ? req.get('X-ROOK-Request-ID') : crypto.randomUUID();
  res.set('X-ROOK-Request-ID',req.v8RequestId);
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
  // Classification is deterministic for a job. Compute it once rather than
  // re-reading all evidence on every sort comparison.
  const scores=new Map(jobs.map(j=>[j,(Number(j.match?.overall_score)||0)+(classify(j).labels.includes(pref)?12:0)]));
  return [...jobs].sort((a,b)=>scores.get(b)-scores.get(a) ||
    (b.match?.overall_score||0)-(a.match?.overall_score||0) || String(a.id).localeCompare(String(b.id)));
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
function previewResponse(profile,jobs,unlocked) {
  return {profile:{home_location_label:profile.home_location_label,desired_industries:profile.desired_industries,
    subscription_status:profile.subscription_status},unlocked,count:jobs.length,
    jobs:jobs.map((j,i)=>unlocked?reveal(j):i<2?reveal(j):project(j,i,{dashboard:true}))};
}
async function previewDetails(jobs,unlocked=false) {
  const ids=jobs.slice(0,unlocked?jobs.length:2).map(j=>j.id);
  if(!ids.length)return jobs;
  // Only jobs actually revealed need identification and application links.
  const {data,error}=await db.from('jobs').select('id,company_name,city,application_url,source_url')
    .eq('status','active').eq('moderation_status','approved').in('id',ids);
  if(error||data?.length!==ids.length)throw Error('Preview details changed; retry search');
  const details=new Map(data.map(j=>[j.id,j]));
  return jobs.map(j=>details.has(j.id)?{...j,...details.get(j.id)}:j);
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
router.post('/prepare',wrap(async(req,res)=>{
  let profile;
  // Preparation depends only on location and can begin before industry is chosen.
  try {profile=validate({...req.body,industry:allowed[0]});} catch(e){return res.status(400).json({error:e.message});}
  // Keep older browsers compatible. Every server warms its own shared index;
  // never trust a visitor pool which could predate an inventory correction.
  res.json({preparation:null});
}));
router.post('/session',wrap(async(req,res)=>{
  let profile;
  try {profile=validate(req.body);} catch(e){return res.status(400).json({error:e.message});}
  const started=performance.now(),timing={validate_with_session:true};
  timing.prepared=0;timing.matching_passes=1;
  const ranked=await rank(db,profile,[],timing);
  timing.preparation_wait_ms=0;
  const priorityStarted=performance.now();
  let jobs=prioritize(ranked,profile.desired_industries[0]);
  timing.industry_ms=performance.now()-priorityStarted;
  const token=crypto.randomBytes(32).toString('hex');
  const persistenceStarted=performance.now();
  const record={token_hash:crypto.createHash('sha256').update(token).digest('hex'),profile,
    jobs:[],expires_at:new Date(Date.now()+24*60*60*1000).toISOString()};
  timing.persistence_bytes=Buffer.byteLength(JSON.stringify(record));timing.persistence_calls=1;
  // Durable token/profile before response preserves immediate claim/checkout.
  // V8 always re-ranks on reload; its old full snapshot was never consumed.
  if(timing.index_revision){
    const save=()=>db.rpc('create_v8_preview_session',{p_token_hash:record.token_hash,p_profile:profile,
      p_expires_at:record.expires_at,p_revision:String(timing.index_revision),p_job_ids:jobs.slice(0,2).map(j=>j.id)});
    let result=await save();
    if(result.error)throw result.error;
    if(!result.data.accepted){
      timing.index_rejected=1;
      // One bounded recovery, never return an outdated index's results.
      await indexFor(db).refresh();
      jobs=prioritize(await rank(db,profile,[],timing),profile.desired_industries[0]);
      result=await save();timing.persistence_calls++;
      if(result.error||!result.data.accepted)throw Error('Inventory is changing; retry search');
    }
    const details=new Map(result.data.jobs.map(j=>[j.id,j]));
    jobs=jobs.map(j=>details.has(j.id)?{...j,...details.get(j.id)}:j);
    timing.persistence_ms=performance.now()-persistenceStarted;
    timing.preview_details_ms=result.data.details_ms;
  } else {
    // Rolling deployment or missing migration: existing authoritative path.
    const [,detailed]=await Promise.all([
      (async()=>{const {error}=await db.from(table).insert(record);if(error)throw error;
        timing.persistence_ms=performance.now()-persistenceStarted;})(),
      (async()=>{const t=performance.now();const result=await previewDetails(jobs);
        timing.preview_details_ms=performance.now()-t;return result;})()
    ]);
    jobs=detailed;
  }
  timing.deferred_persistence_ms=0;delete timing.validate_with_session;
  const projectionStarted=performance.now();
  // Freshly ranked against this request's validated location. Keep persisted
  // snapshots private; only the established server-side allowlists cross here.
  const preview=previewResponse(profile,jobs,false);
  timing.response_ms=performance.now()-projectionStarted;
  timing.total_ms=performance.now()-started;
  res.set('Server-Timing',Object.entries(timing).filter(([k])=>k.endsWith('_ms'))
    .map(([k,v])=>`${k.slice(0,-3)};dur=${v.toFixed(1)}`).join(', '));
  res.json({token,preview,timing:Object.fromEntries(Object.entries(timing).map(([k,v])=>[k,Math.round(v)]))});
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
  // Reloads still re-rank current inventory: old snapshots can predate a
  // location correction. Initial POST now returns its fresh safe projection.
  const jobs=await previewDetails(prioritize(await rank(db,profile,[]),profile.desired_industries[0]),unlocked);
  res.json(previewResponse(profile,jobs,unlocked));
}));
router.put('/preference',wrap(async(req,res)=>{
  const s=await session(req);
  if(!s) return res.status(410).json({error:'Your search expired.'});
  const u=await user(req);
  if(s.user_id && s.user_id!==u?.id) return res.status(403).json({error:'Sign in to your account.'});
  const industry=req.body?.industry;
  if(!allowed.includes(industry)) return res.status(400).json({error:'Select an industry preference.'});
  const profile={...s.profile,desired_industries:[industry]};
  let query=db.from(table).update({profile,jobs:[]}).eq('token_hash',s.token_hash);
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
    const {error}=await db.from('candidate_profiles').upsert({...profile,user_id:u.id,email:u.email,...(name?{name}:{})},{onConflict:'user_id'});
    if(error)throw error;
    const saved=await db.from(table).update({transferred_at:new Date().toISOString()}).eq('token_hash',s.token_hash).eq('user_id',u.id);
    if(saved.error)throw saved.error;
  }
  res.json({ok:true});
}));
module.exports=router;
module.exports._test={validate,prioritize,reveal};
