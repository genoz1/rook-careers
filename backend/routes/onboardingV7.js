// V7-only session boundary. All storage is private and service-role-only.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const {createClient} = require('@supabase/supabase-js');
const {hasFullAccess} = require('../matching');
const {preview, answersToProfile} = require('../v7Preview');
const {rank} = require('../v7Matching');
const {repairSnapshot} = require('../v7Location');
const {normalizeSelection} = require('../../public/rook-job-classification');
const router = express.Router();
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
const upload = multer({storage:multer.memoryStorage(), limits:{fileSize:10*1024*1024, files:1}});
const table = 'onboarding_v7_sessions';
const bucket = 'onboarding-v7-private';
const calls = new Map();
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(() => res.status(503).json({error:'Unable to load your matches. Please try again.'}));
router.use((req,res,next) => {
  res.set('Cache-Control','private, no-store');
  if (!db) return res.status(503).json({error:'V7 is not configured yet.'});
  // Bound both uploads and expensive scoring; never trust a caller-supplied XFF.
  const ip = req.ip;
  const now = Date.now();
  for (const [key,v] of calls) if (v.until < now) calls.delete(key);
  const entry = calls.get(ip) || {count:0, until:now+60000};
  if (++entry.count>40 || calls.size>10000) return res.status(429).json({error:'Please wait a minute and try again.'});
  calls.set(ip,entry); next();
});
async function session(req) {
  const token = req.get('X-ROOK-V7') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const {data,error} = await db.from(table).select('*').eq('token_hash',hash).gt('expires_at',new Date().toISOString()).maybeSingle();
  if (error) throw error;
  return data;
}
async function user(req) {
  const token = (req.get('Authorization') || '').replace(/^Bearer /,'');
  if (!token) return null;
  const {data,error} = await db.auth.getUser(token);
  return !error && data?.user?.email_confirmed_at ? data.user : null;
}
async function owned(req,res) {
  const [s,u] = await Promise.all([session(req),user(req)]);
  if (!s || !u || s.user_id !== u.id) { res.status(403).json({error:'Sign in to the account that created these matches.'}); return null; }
  return {s,u};
}
router.post('/session', wrap(async (req,res) => {
  let profile;
  try {profile=answersToProfile(req.body);} catch(e) {return res.status(400).json({error:e.message});}
  const jobs = await rank(db,profile);
  const token = crypto.randomBytes(32).toString('hex');
  const {error} = await db.from(table).insert({token_hash:crypto.createHash('sha256').update(token).digest('hex'), profile, jobs, expires_at:new Date(Date.now()+24*60*60*1000).toISOString()});
  if (error) throw error;
  res.json({token});
}));
router.put('/location', wrap(async (req,res) => {
  const s = await session(req);
  if (!s) return res.status(410).json({error:'Your saved matches expired. Please start again.'});
  const u = await user(req);
  if (s.user_id && s.user_id !== u?.id) return res.status(403).json({error:'Sign in to your account to continue.'});
  let validated;
  const b=req.body || {};
  try {
    validated=answersToProfile({location:{lat:b.home_lat,lng:b.home_lng,city:b.home_city,state:b.home_state,zip:b.home_zip,label:b.home_location_label},industry:s.profile.desired_industries[0],years:s.profile.total_sales_years,territories:s.profile.territory_size_preferences});
  } catch(e) {return res.status(400).json({error:e.message});}
  const location=Object.fromEntries(Object.entries(validated).filter(([k])=>k.startsWith('home_')));
  const profile={...s.profile,...location};
  const jobs=await rank(db,profile);
  let update=db.from(table).update({profile,jobs}).eq('token_hash',s.token_hash);
  update=s.user_id ? update.eq('user_id',s.user_id) : update.is('user_id',null);
  const saved=await update.select('token_hash').maybeSingle();
  if(saved.error) throw saved.error;
  if(!saved.data) return res.status(409).json({error:'Your account changed during the search. Please retry.'});
  if(s.user_id) {
    const result=await db.from('candidate_profiles').update(location).eq('user_id',s.user_id);
    if(result.error) throw result.error;
  }
  res.json({ok:true});
}));
router.get('/session', wrap(async (req,res) => {
  const s = await session(req);
  if (!s) return res.status(410).json({error:'Your saved matches expired. Please start again.'});
  const u = await user(req);
  if (s.user_id && s.user_id !== u?.id) return res.status(403).json({error:'Sign in to your account to continue.'});
  let profile = {...s.profile, resume_file_path:s.resume_path ? 'pending' : null};
  if (u && s.user_id === u.id) {
    const {data,error} = await db.from('candidate_profiles').select('*').eq('user_id',u.id).maybeSingle();
    if (error) throw error;
    profile = {...profile,...data,...s.profile};
  }
  if (s.resume_path && !profile.resume_file_path) profile.resume_file_path = 'pending';
  const unlocked = !!(s.user_id && u?.id === s.user_id && hasFullAccess(profile));
  // Revalidate old snapshots too, before either masked or unlocked serialization.
  // Use the saved answers so purchasing never swaps in a different result set.
  const requested = req.query?.industries;
  const selection = requested === 'all' ? [] : String(requested || '').split(',');
  const jobs = requested !== undefined
    ? (requested !== 'all' && !normalizeSelection(selection).length ? [] : await rank(db,profile,selection))
    : repairSnapshot(s.jobs,s.profile);
  // Even a forged query param or a valid token for another paid user cannot unlock.
  res.json({profile, unlocked, resume_pending:!!s.resume_path, jobs:unlocked ? jobs.map(j=>({...j,subscription_required:false})) : jobs.map(preview)});
}));
router.post('/claim', wrap(async (req,res) => {
  let s = await session(req);
  const u = await user(req);
  if (!s || !u) return res.status(401).json({error:'Verify your email and sign in first.'});
  if (!s.user_id) {
    // Compare-and-set: concurrent callers cannot claim the same anonymous upload.
    const {data,error} = await db.from(table).update({user_id:u.id}).eq('token_hash',s.token_hash).is('user_id',null).select('*').maybeSingle();
    if (error) throw error;
    s = data || await session(req);
  }
  if (s.user_id !== u.id) return res.status(403).json({error:'These matches belong to another account.'});
  if (!s.transferred_at) {
    const name = [u.user_metadata?.first_name,u.user_metadata?.last_name].filter(Boolean).join(' ');
    const {error} = await db.from('candidate_profiles').upsert({...s.profile,user_id:u.id,...(name ? {name}:{}),updated_at:new Date().toISOString()},{onConflict:'user_id'});
    if (error) throw error;
    const done = await db.from(table).update({transferred_at:new Date().toISOString()}).eq('token_hash',s.token_hash).eq('user_id',u.id);
    if (done.error) throw done.error;
  }
  res.json({ok:true});
}));
router.post('/resume', wrap(async(req,res,next) => {
  const s = await session(req);
  if (!s) return res.status(410).json({error:'Session expired.'});
  if (s.user_id) return res.status(409).json({error:'Sign in and use your dashboard to upload.'});
  req.v7=s; next();
}), upload.single('resume'), wrap(async(req,res) => {
  if (!req.file || !/\.(pdf|docx?|DOCX?|PDF)$/.test(req.file.originalname)) return res.status(400).json({error:'Choose a PDF or Word résumé.'});
  const s=req.v7;
  const path=`${s.token_hash}/${crypto.randomUUID()}`;
  const {error} = await db.storage.from(bucket).upload(path,req.file.buffer,{contentType:'application/octet-stream',upsert:false});
  if (error) throw error;
  const saved=await db.from(table).update({resume_path:path,resume_name:req.file.originalname.slice(0,180),resume_type:req.file.mimetype}).eq('token_hash',s.token_hash).is('user_id',null).select('token_hash').maybeSingle();
  if (saved.error || !saved.data) {
    await db.storage.from(bucket).remove([path]);
    return res.status(409).json({error:'Your account was created during upload. Upload from your dashboard.'});
  }
  if (s.resume_path) await db.storage.from(bucket).remove([s.resume_path]);
  res.json({ok:true});
}));
router.get('/resume', wrap(async(req,res) => {
  const context=await owned(req,res); if (!context) return;
  const {s}=context;
  if (!s.resume_path) return res.status(404).json({error:'No pending résumé.'});
  const {data,error}=await db.storage.from(bucket).download(s.resume_path);
  if (error) throw error;
  res.set('Content-Type','application/octet-stream');
  res.set('X-Resume-Name',encodeURIComponent(s.resume_name));
  res.set('X-Resume-Type',s.resume_type || 'application/octet-stream');
  res.send(Buffer.from(await data.arrayBuffer()));
}));
router.post('/resume-complete', wrap(async(req,res) => {
  const context=await owned(req,res); if (!context) return;
  const {s,u}=context;
  const {data,error}=await db.from('candidate_profiles').select('resume_file_path').eq('user_id',u.id).maybeSingle();
  if (error || !data?.resume_file_path) return res.status(409).json({error:'Résumé processing has not completed.'});
  if (s.resume_path) {
    const removed=await db.storage.from(bucket).remove([s.resume_path]); if (removed.error) throw removed.error;
    const saved=await db.from(table).update({resume_path:null,resume_name:null,resume_type:null}).eq('token_hash',s.token_hash); if(saved.error) throw saved.error;
  }
  res.json({ok:true});
}));
// Expired drafts are inaccessible immediately; remove private files before rows.
async function cleanup() {
  if(!db) return;
  const {data,error}=await db.from(table).select('token_hash,resume_path').lt('expires_at',new Date().toISOString()).limit(100);
  if(error) return;
  for(const s of data || []) {
    // Include interrupted/replaced uploads in the expired session folder.
    const listed=await db.storage.from(bucket).list(s.token_hash,{limit:1000});
    if(listed.error) continue;
    const paths=(listed.data || []).map(f=>`${s.token_hash}/${f.name}`);
    if(paths.length) {const r=await db.storage.from(bucket).remove(paths);if(r.error) continue;}
    await db.from(table).delete().eq('token_hash',s.token_hash);
  }
}
const timer=setInterval(()=>cleanup().catch(()=>{}),60*60*1000);timer.unref();
router.use((err,req,res,next)=>res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Choose a résumé under 10 MB.':'Unable to upload. Please try again.'}));
module.exports=router;
