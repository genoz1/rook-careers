'use strict';
const {SupabaseAcquisitionStore}=require('./store');
const {signer}=require('./security');
const {createRouter,webhookRouter}=require('./routes');
const {createStripeObserver}=require('./stripeAdapter');
const {createBufferAdapter}=require('./bufferAdapter');
const worker=require('./worker');
function createRuntime(env=process.env){
 if(env.ROOK_ACQUISITION_ENABLED!=='true')return null;
 if(!['staging','production'].includes(env.ACQ_ENVIRONMENT))throw Error('Explicit acquisition environment required');
 if(env.ACQ_ENVIRONMENT==='staging'&&!env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw Error('Staging requires a Stripe test-mode key');
 if(env.ACQ_ENVIRONMENT==='production'&&!env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))throw Error('Production observer requires the existing live Stripe account');
 const client=require('../resources/store').db(),store=new SupabaseAcquisitionStore(client),signed=signer(env.ACQ_SIGNING_SECRET);
 const stripe=new (require('stripe'))(env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:20000,maxNetworkRetries:2});
 const lookupProfile=async customer=>{const {data,error}=await client.from('candidate_profiles').select('user_id,email,utm_source,utm_medium').eq('stripe_customer_id',customer).maybeSingle();if(error)throw Error('Verified customer mapping unavailable');return data?{userId:data.user_id,email:data.email,channel:[data.utm_source,data.utm_medium].filter(Boolean).join(' / ')||'unattributed'}:null;};
 const observer=createStripeObserver({stripe,store,identity:signed.identity,monthlyPriceId:env.STRIPE_PRICE_ID_MONTHLY,lookupProfile});
 const authenticate=async req=>{const token=(req.get('authorization')||'').replace(/^Bearer /,'');if(!token)return null;const {data,error}=await client.auth.getUser(token);return error?null:data?.user;};
 const router=createRouter({store,signer:signed,authenticate,adminEmails:(env.ADMIN_EMAILS||'').split(',').map(e=>e.trim()).filter(Boolean)});
 const webhooks=webhookRouter({stripe,secret:env.ACQ_STRIPE_WEBHOOK_SECRET,observer,expectedLiveMode:env.ACQ_ENVIRONMENT==='production'});
 const adapter=createBufferAdapter({token:env.BUFFER_ACCESS_TOKEN,linkedinChannelId:env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,facebookChannelId:env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID,liveApproved:env.ACQ_ENVIRONMENT==='production'&&env.ACQ_PUBLICATION_APPROVED==='true',beforeRequest:async()=>{const d=new Date().toISOString();const b=await store.call('budget',{month:d.slice(0,7),day:d.slice(0,10),dailyLimit:50,monthlyLimit:900});if(!b.allowed)throw Object.assign(Error('Acquisition Buffer request budget exhausted'),{definitelyNotAccepted:true});}});
 const stage=s=>env['ACQ_'+s+'_APPROVED']==='true';
 let running=false;
 async function tick(){
  if(running)return;running=true;const now=Date.now(),errors=[];
  const attempt=async(name,fn)=>{try{return await fn();}catch{errors.push(name);return null;}};
  try{
   const lease=await store.call('lease',{id:'supervisor',now:new Date(now).toISOString(),expiresAt:new Date(now+240000).toISOString()});if(!lease.acquired)return;
   const latest=await store.call('get',{kind:'metrics',id:'stripe'});
   if(!latest||now-Date.parse(latest.capturedAt)>20*3600000){
    await attempt('stripe_payment_reconciliation',()=>observer.reconcile());
    await attempt('stripe_reconciliation',()=>observer.metrics());
    const analytics=await attempt('analytics',()=>require('./analytics').collectAnalytics({credentials:(env.ACQ_GOOGLE_SERVICE_ACCOUNT_JSON||env.GA4_SERVICE_ACCOUNT_JSON)?JSON.parse(env.ACQ_GOOGLE_SERVICE_ACCOUNT_JSON||env.GA4_SERVICE_ACCOUNT_JSON):null,gaProperty:env.ACQ_GA4_PROPERTY||env.GA4_PROPERTY_ID||'552914293',gscProperty:env.ACQ_GSC_PROPERTY}));
    if(analytics)await store.call('put',{kind:'metrics',id:'analytics',body:analytics});
   }
   const seo=await store.call('get',{kind:'seo',id:'latest'});
   if(!seo||now-Date.parse(seo.capturedAt)>7*86400000){const audit=await attempt('seo_audit',()=>require('./seoMonitor').auditPublicResources());if(audit)await store.call('put',{kind:'seo',id:'latest',body:audit});}
   if(stage('REPORT_PUBLICATION')){const snapshot=await attempt('aggregate_refresh',()=>worker.refreshInventory(store));if(snapshot)await attempt('report_publication',()=>worker.publishReports(store,snapshot,now));}
   if(stage('PUBLICATION')&&env.ACQ_ENVIRONMENT==='production'){
    const channels=await attempt('channel_authorization',()=>adapter.channels());
    if(channels){const externalSchedule=await attempt('existing_schedule_coordination',()=>adapter.schedule());if(externalSchedule)await attempt('reserve_replenishment',()=>worker.replenish(store,{channels,now,externalSchedule}));}
    for(let i=0;i<4;i++){const result=await attempt('social_delivery',()=>worker.dispatchOne(store,{adapter}));if(!result)break;}
   }
   if(stage('PARTNER_DISCOVERY'))await attempt('partner_discovery',()=>require('./partners').discover(store));
   if(stage('PARTNER_EMAIL')){
    await attempt('email_preparation',()=>require('./partners').schedulePartnerMessages(store,{postalAddress:env.ACQ_POSTAL_ADDRESS,followupsEnabled:env.ACQ_REPLY_SUPPRESSION_VERIFIED==='true'&&Boolean(env.ACQ_PARTNER_REPLY_EMAIL&&env.ACQ_RESEND_WEBHOOK_SECRET)}));
    for(let i=0;i<2;i++){const result=await attempt('permissioned_email',()=>require('./emailWorker').dispatchPartnerEmail(store,{signer:signed,read:id=>require('./resendReceipt').readEmailReceipt(id,{token:env.RESEND_API_KEY}),send:async args=>{const d=new Date().toISOString();const b=await store.call('budget',{scope:'email',month:d.slice(0,7),day:d.slice(0,10),dailyLimit:10,monthlyLimit:250});if(!b.allowed)throw Object.assign(Error('Partner email budget exhausted'),{definitelyNotAccepted:true});return require('../email/resend').sendEmail({...args,replyTo:env.ACQ_PARTNER_REPLY_EMAIL});},postalAddress:env.ACQ_POSTAL_ADDRESS,enabled:true}));if(!result)break;}
   }
   await attempt('payout_preparation',()=>store.call('prepare_batch',{id:'monthly-'+new Date(now).toISOString().slice(0,7),now:new Date(now).toISOString()}));
   const health={...await worker.health(store),errors};await store.call('put',{kind:'metrics',id:'health',body:health});
   const week=new Date(now).toISOString().slice(0,10);
   if(new Date(now).getUTCDay()===1)await store.call('put',{kind:'metrics',id:'weekly-'+week,body:{health,stripe:await store.call('get',{kind:'metrics',id:'stripe'}),revenueByChannel:await store.call('revenue')}});
   // Only an explicitly authorized owner recipient can receive exception alerts.
   if(stage('ALERT_EMAIL')&&env.ACQ_ALERT_EMAIL&&(errors.length||health.overdue)){
    const key='alert-'+week,prior=await store.call('get',{kind:'metrics',id:key});
    if(!prior){await attempt('owner_alert',()=>require('../email/resend').sendEmail({to:env.ACQ_ALERT_EMAIL,subject:'ROOK automation needs account attention',idempotencyKey:'rook-acq-'+key,html:'<p>ROOK automatic retries are continuing. The private acquisition dashboard reports a persistent service, authorization or delivery problem. Review /internal/acquisition after signing in.</p>'}));await store.call('put',{kind:'metrics',id:key,body:{attemptedAt:new Date(now).toISOString()}});}
   }
  }finally{running=false;}
 }
 function start(){if(env.ACQ_SCHEDULER_APPROVED!=='true')return;const timer=setInterval(()=>tick().catch(()=>console.error('[acquisition] supervisor failed')),300000);timer.unref();setTimeout(()=>tick().catch(()=>console.error('[acquisition] startup check failed')),10000).unref();return timer;}
 const emailWebhooks=require('./emailWebhooks').createEmailWebhooks({store,signer:signed,secret:env.ACQ_RESEND_WEBHOOK_SECRET,replyAddress:env.ACQ_PARTNER_REPLY_EMAIL});
 return {router,webhooks,emailWebhooks,start,tick,store,observer};
}
module.exports={createRuntime};
