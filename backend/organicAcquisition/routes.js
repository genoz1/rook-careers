'use strict';
const express=require('express');
const crypto=require('node:crypto');
const {escape:esc,cookies,equal,digest}=require('./security');
const {ORIGIN,reportHtml}=require('./content');
function page(title,path,body,{privatePage=false,scripts=''}={}){
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ROOK Careers</title><meta name="description" content="${esc(title)}. Medical sales career guidance and ROOK’s employer-direct membership database."><link rel="canonical" href="${ORIGIN}${esc(path)}">${privatePage?'<meta name="robots" content="noindex,nofollow">':''}<style>body{font:17px/1.6 system-ui;margin:auto;padding:24px;max-width:1000px;color:#102b3a;overflow-wrap:anywhere}nav{display:flex;gap:20px;flex-wrap:wrap}button,a{color:#146171}button{padding:12px;cursor:pointer}table{border-collapse:collapse;width:100%;display:block;overflow:auto}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd}label{display:block;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{max-width:100%}</style></head><body><nav><a href="/">ROOK Careers</a><a href="/jobs/category/medical-sales-jobs">Medical sales careers</a><a href="/resources/">Career resources</a><a href="/hiring-reports/">Hiring reports</a><a href="/partners/">Partner program</a></nav><main>${body}</main>${privatePage?'':'<script src="/rook-attribution.js"></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-LDG2CL5Z8R"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-LDG2CL5Z8R");</script>'}${scripts}</body></html>`;
}
const authScripts='<script src="/rook-config.js"></script><script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script><script src="/rook-auth.js"></script><script src="/acquisition-ui.js" defer></script>';
function createRouter({store,signer,authenticate,adminEmails=[],clock=Date.now,secureCookies=true}){
 const router=express.Router();
 const safe=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch{res.status(503).set('Cache-Control','no-store').json({error:'ROOK acquisition service temporarily unavailable'});}};
 router.get('/robots.txt',(req,res)=>res.type('text/plain').send(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../public/robots.txt'),'utf8')+'\nDisallow: /r/\nDisallow: /partners/dashboard\nDisallow: /internal/\nSitemap: '+ORIGIN+'/hiring-reports/sitemap.xml\n'));
 const auth=safe(async(req,res,next)=>{const u=await authenticate(req);if(!u?.id||!u.email||!u.email_confirmed_at)return res.status(401).json({error:'Sign in with a verified email to continue'});req.acqUser=u;next();});
 const admin=(req,res,next)=>adminEmails.map(e=>e.toLowerCase()).includes(req.acqUser.email.toLowerCase())?next():res.status(403).json({error:'Not authorized'});
 router.use(['/api/acquisition','/internal/acquisition','/partners/dashboard'],(req,res,next)=>{res.set('Cache-Control','no-store').set('X-Robots-Tag','noindex, nofollow');next();});
 // Passive, server-verified attribution. A failure never blocks an existing API request.
 router.use('/api',async(req,res,next)=>{
  if(req.path.startsWith('/acquisition')||!cookies(req).rook_referral||!req.get('authorization'))return next();
  try{const ref=signer.read(cookies(req).rook_referral,clock());if(ref?.purpose==='referral'){
   const u=await authenticate(req);if(u?.id&&u.email&&u.email_confirmed_at){const bound=await store.call('bind',{userId:u.id,identityHash:signer.identity(u.email),partnerId:ref.partnerId,boundAt:new Date(clock()).toISOString(),expiresAt:new Date(ref.exp).toISOString()});if(bound.bound)res.clearCookie('rook_referral',{httpOnly:true,secure:secureCookies,sameSite:'lax',path:'/'});}
  }}catch{/* isolate sidecar from existing customer operations */}next();
 });
 router.get('/r/:code',safe(async(req,res)=>{
  res.set('Cache-Control','no-store').set('X-Robots-Tag','noindex, nofollow').set('Referrer-Policy','no-referrer');
  if(!/^[A-Za-z0-9_-]{24}$/.test(req.params.code))return res.status(404).send('Referral not found');
  const p=await store.call('get',{kind:'partner',id:req.params.code});if(!p||p.status!=='active')return res.status(404).send('Referral not found');
  const old=signer.read(cookies(req).rook_referral,clock());
  if(old?.purpose!=='referral')res.cookie('rook_referral',signer.sign({purpose:'referral',partnerId:p.id,exp:clock()+30*86400000}),{httpOnly:true,secure:secureCookies,sameSite:'lax',maxAge:30*86400000,path:'/'});
  // No partner-controlled redirect target, title, employer, location or application URL.
  res.redirect(302,'/jobs/category/medical-sales-jobs?utm_source=rook_partner&utm_medium=referral&utm_campaign=partner_program');
 }));
 router.get('/partners',safe(async(req,res)=>res.type('html').send(page('ROOK referral partner program','/partners/',`<h1>Help medical sales candidates find their next move</h1><p>ROOK curates medical, pharmaceutical, diagnostics, veterinary and animal-health sales opportunities from employer career sites. Public previews protect individual listings; paid membership unlocks the database.</p><h2>Earn a $5 one-time referral commission</h2><p>A verified new paying monthly subscriber can earn your account one $5 commission. No commission is earned for renewals, existing or returning monthly subscribers, self-referrals, failed payments or one-time passes. A valid link must be followed before the account binds its first eligible referral; attribution lasts up to 30 days. Refunds and disputes can invalidate a commission.</p><p>Commissions have a 30-day hold. The proposed payout minimum is $10, with smaller balances carried forward. Payment timing depends on the approved payment integration and verified payee details; no automatic payment promise is made before that integration is enabled.</p><h2>Share responsibly</h2><p>Clearly disclose that you may earn a commission near your link. Share with your own audience under its rules. No unsolicited email, spam, misleading earnings claims or protected job details.</p><p>Example disclosure: “I may earn a $5 commission if you become a new paying ROOK monthly subscriber through this link.”</p><a href="/partners/dashboard/">Join free or manage your referral link</a>`))));
 router.get('/partners/dashboard',safe(async(req,res)=>res.type('html').send(page('Partner dashboard','/partners/dashboard/',`<h1>Your ROOK partner account</h1><p>Sign in with your existing verified ROOK account. Joining the partner program does not require a subscription.</p><a id="partner-signin" href="/rook-login.html">Sign in</a><form id="partner-enroll"><label><input id="terms" type="checkbox" required> I accept the <a href="/partners/">referral rules</a> and disclosure requirement.</label><label><input id="marketing" type="checkbox"> Send me ROOK partner onboarding and occasional referral tips. Optional; unsubscribe anytime.</label><button>Get my referral link</button></form><section id="partner-result" aria-live="polite"></section>`,{privatePage:true,scripts:authScripts}))));
 router.post('/api/acquisition/partners',auth,safe(async(req,res)=>{
  if(req.body?.terms!==true)return res.status(400).json({error:'Accept referral rules first'});
  const u=req.acqUser,id=crypto.randomBytes(18).toString('base64url');
  const p=await store.call('enroll',{id,userId:u.id,email:u.email,identityHash:signer.identity(u.email),emailVerified:true,status:'active',marketingConsent:req.body.marketingConsent===true,consentVersion:'rook-partner-v1',createdAt:new Date(clock()).toISOString()});
  res.json({referralLink:ORIGIN+'/r/'+p.id,marketingConsent:p.marketingConsent});
 }));
 router.get('/api/acquisition/partner',auth,safe(async(req,res)=>{
  const p=(await store.call('list',{kind:'partner'})).find(row=>row.body.userId===req.acqUser.id)?.body;
  if(!p)return res.status(404).json({error:'No partner account'});
  const commissions=await store.call('commissions',{partnerId:p.id});
  const totals={owedCents:0,paidCents:0,heldCents:0,reversedCents:0,conversions:commissions.length};
  for(const c of commissions){if(c.status==='paid')totals.paidCents+=500;else if(['reversed','recovery_review'].includes(c.status))totals.reversedCents+=500;else {totals.owedCents+=500;if(c.status==='held')totals.heldCents+=500;}}
  res.json({referralLink:ORIGIN+'/r/'+p.id,totals,commissions:commissions.map(c=>({amountCents:c.amount_cents,status:c.status,eligibleAt:c.eligible_at})),disclosure:'I may earn a $5 commission if you become a new paying ROOK monthly subscriber through this link.'});
 }));
 router.get('/partners/unsubscribe',safe(async(req,res)=>res.type('html').send(page('Unsubscribe from partner email','/partners/unsubscribe',`<h1>Partner email preferences</h1><form method="post" action="/partners/unsubscribe"><input type="hidden" name="token" value="${esc(typeof req.query.token==='string'?req.query.token:'')}"><button>Unsubscribe from partner emails</button></form>`,{privatePage:true}))));
 router.post('/partners/unsubscribe',express.urlencoded({extended:false,limit:'4kb'}),safe(async(req,res)=>{
  const p=signer.read(req.body.token,clock());if(p?.purpose!=='unsubscribe')return res.status(400).send('Invalid preference link');
  await store.call('put',{kind:'suppression',id:p.identityHash,body:{at:new Date(clock()).toISOString(),reason:'unsubscribe'}});res.send('You are unsubscribed from partner marketing email.');
 }));
 router.get('/hiring-reports/sitemap.xml',safe(async(req,res)=>{
  const rows=await store.call('list',{kind:'report'});res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/hiring-reports/</loc></url><url><loc>${ORIGIN}/partners/</loc></url>${rows.map(r=>`<url><loc>${ORIGIN}/hiring-reports/${esc(r.id)}/</loc><lastmod>${esc(r.body.publishedAt)}</lastmod></url>`).join('')}</urlset>`);
 }));
 router.get('/hiring-reports',safe(async(req,res)=>{
  const rows=await store.call('list',{kind:'report'});res.type('html').send(page('ROOK hiring intelligence','/hiring-reports/',`<h1>ROOK hiring intelligence</h1><p>Original snapshots of ROOK’s tracked sales opportunities. These describe our inventory, not the entire employment market.</p><ul>${rows.map(r=>`<li><a href="/hiring-reports/${esc(r.id)}/">${esc(r.body.title)}</a></li>`).join('')}</ul>`));
 }));
 router.get('/hiring-reports/:slug',safe(async(req,res)=>{
  if(!/^[a-z0-9-]{1,100}$/.test(req.params.slug))return res.status(404).send('Not found');const r=await store.call('get',{kind:'report',id:req.params.slug});if(!r)return res.status(404).send('Not found');
  res.type('html').send(page(r.title,'/hiring-reports/'+r.slug+'/',`<div data-content-hash="${esc(r.hash)}">${reportHtml(r)}</div>`));
 }));
 // Public empty shell; all private metrics still require verified admin bearer auth.
 router.get('/internal/acquisition',safe(async(req,res)=>res.type('html').send(page('Revenue automation dashboard','/internal/acquisition',`<h1>ROOK revenue and acquisition</h1><p>Stripe confirms revenue. Unavailable analytics are shown explicitly.</p><section id="acquisition-metrics" aria-live="polite"></section>`,{privatePage:true,scripts:authScripts}))));
 router.get('/api/acquisition/admin',auth,admin,safe(async(req,res)=>{
  const stripe=await store.call('get',{kind:'metrics',id:'stripe'}),analytics=await store.call('get',{kind:'metrics',id:'analytics'}),health=await store.call('get',{kind:'metrics',id:'health'}),seo=await store.call('get',{kind:'seo',id:'latest'});
  const commissions=await store.call('commissions');const revenue=await store.call('revenue');
  res.json({stripe:stripe||{unavailable:'Stripe reconciliation not completed'},analytics:analytics||{unavailable:'GA4 and Search Console read-only access not configured'},health:health||{unavailable:'Worker has not run'},seo:seo||{unavailable:'SEO checks have not run'},revenueByChannel:revenue,partners:(await store.call('list',{kind:'partner'})).length,commissions,provenance:'Stripe-confirmed invoice payments; channel is attribution, not proof of causation'});
 }));
 router.post('/api/acquisition/admin/payout-prepare',auth,admin,safe(async(req,res)=>{const id='monthly-'+new Date(clock()).toISOString().slice(0,7);await store.call('prepare_batch',{id,now:new Date(clock()).toISOString()});res.json(await require('./payouts').reviewBatch(store,id));}));
 return router;
}
function webhookRouter({stripe,secret,observer,expectedLiveMode}){
 const router=express.Router();router.post('/api/acquisition/stripe-webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
  let event;try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),secret);if(event.livemode!==expectedLiveMode)throw Error('Mode mismatch');}catch{return res.status(400).json({received:false});}
  try{await observer.process(event);res.json({received:true});}catch{res.status(503).json({received:false});}
 });return router;
}
module.exports={createRouter,webhookRouter,page};
