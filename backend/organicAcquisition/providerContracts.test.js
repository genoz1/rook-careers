'use strict';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const express=require('express');
const Stripe=require('stripe');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresAcquisitionStore}=require('./store');
const {createStripeObserver}=require('./stripeAdapter');
const {webhookRouter}=require('./routes');
const {signer}=require('./security');
const {createBufferAdapter}=require('./bufferAdapter');
let db,store,provider,appServer,origin,webOrigin,stripe,observer;
let requests=[],posts=[],failAfterAccept=false,invoiceOverrides={},customerOverrides={},historical=[];
const NOW=Date.now(),signed=signer('local-provider-contract-signing-key-with-32-characters');
const secret='whsec_local_contract_fixture';
const list=data=>({object:'list',data,has_more:false,url:'/v1/fixture'});
const invoice=(id='in_new',customer='cus_new')=>({id,object:'invoice',customer,subscription:customer==='cus_new'?'sub_new':'sub_'+customer,status:'paid',amount_paid:customer==='cus_new'?999:1999,currency:'usd',paid_out_of_band:false,created:Math.floor(NOW/1000)-60,billing_reason:'subscription_create',status_transitions:{paid_at:Math.floor(NOW/1000)},charge:{id:'ch_'+id,object:'charge',invoice:id,paid:true,refunded:false,disputed:false,amount_refunded:0,payment_method_details:{card:{fingerprint:'card_'+customer}}},lines:list([{price:{id:'price_existing_monthly'}}]),...invoiceOverrides});
const price={id:'price_existing_monthly',object:'price',product:'prod_rook',unit_amount:1999,currency:'usd',recurring:{interval:'month',interval_count:1}};
const sub=(customer='cus_new')=>({id:customer==='cus_new'?'sub_new':'sub_'+customer,object:'subscription',customer,status:'active',created:Math.floor(NOW/1000),items:list([{price,quantity:1}]),latest_invoice:invoice(customer==='cus_new'?'in_new':'in_'+customer,customer)});
before(async()=>{
 db=new PGlite();await db.exec(fs.readFileSync(require.resolve('./schema.sql'),'utf8'));store=new PostgresAcquisitionStore(db);
 provider=http.createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url});res.setHeader('Content-Type','application/json');
  const url=new URL(req.url,'http://localhost'),p=url.pathname;
  if(p==='/buffer'){
   let raw='';for await(const chunk of req)raw+=chunk;const {query,variables:v}=JSON.parse(raw);let data;
   if(query.includes('GetOrganizations'))data={account:{organizations:[{id:'org_rook',name:'ROOK'}]}};
   else if(query.includes('GetChannels'))data={channels:[{id:'li_rook',name:'ROOK Careers',service:'linkedin'},{id:'fb_rook',name:'ROOK Careers',service:'facebook'},{id:'personal',name:'Gene',service:'linkedin'},{id:'buzz',name:'Florida Buzz',service:'facebook'}]};
   else if(query.includes('mutation CreatePost')){
    const i=v.input;assert.ok(['li_rook','fb_rook'].includes(i.channelId));if(i.channelId==='fb_rook')assert.equal(i.metadata.facebook.type,'post');
    const post={id:'buffer_'+(posts.length+1),text:i.text,channelId:i.channelId,status:i.saveToDraft?'draft':'sent',sentAt:i.saveToDraft?null:new Date().toISOString()};posts.push(post);
    if(failAfterAccept){req.socket.destroy();return;}data={createPost:{post}};
   }else if(query.includes('DeleteDraft')){posts=posts.filter(p=>p.id!==v.input.id);data={deletePost:{__typename:'DeletePostSuccess'}};}else if(query.includes('Queue'))data={account:{organizations:[{id:'org_rook',limits:{scheduledPosts:10}}]},posts:{edges:[],pageInfo:{hasNextPage:false,endCursor:null}}};
   else data={posts:{edges:posts.map(node=>({node}))}};
   res.end(JSON.stringify({data}));return;
  }
  let data;
  if(p==='/v1/customers')data=list(['cus_old1','cus_old2','cus_old3'].map(id=>({id,email:id+'@example.test'})));
  else if(p.startsWith('/v1/customers/'))data={id:p.split('/').pop(),email:'buyer@example.test',...customerOverrides};
  else if(p==='/v1/invoices'){const c=url.searchParams.get('customer')||'cus_new';data=list([invoice(c==='cus_new'?'in_new':'in_'+c,c),...historical]);}
  else if(p==='/v1/invoices/in_new')data=invoice();
  else if(p==='/v1/prices/price_existing_monthly')data=price;
  else if(p==='/v1/subscriptions/sub_new')data=sub();
  else if(p==='/v1/subscriptions')data=list(['cus_new','cus_old1','cus_old2','cus_old3'].map(sub));
  else if(p.startsWith('/v1/charges/'))data={...invoice().charge,invoice:'in_new'};
  else{res.statusCode=404;data={error:{message:'Fixture endpoint unavailable'}};}
  res.end(JSON.stringify(data));
 });provider.listen(0,'127.0.0.1');await new Promise(r=>provider.once('listening',r));origin='http://127.0.0.1:'+provider.address().port;
 stripe=new Stripe('sk_test_ROOK_LOCAL_CONTRACT_ONLY',{host:'127.0.0.1',port:provider.address().port,protocol:'http',apiVersion:'2024-06-20',maxNetworkRetries:0,timeout:2000});
 observer=createStripeObserver({stripe,store,identity:signed.identity,monthlyPriceId:price.id,lookupProfile:async id=>({userId:id==='cus_new'?'buyer':id,email:id==='cus_new'?'buyer@example.test':id+'@example.test',channel:'google / organic'}),clock:()=>NOW});
 const app=express();app.use(webhookRouter({stripe,secret,observer,expectedLiveMode:false}));appServer=app.listen(0,'127.0.0.1');await new Promise(r=>appServer.once('listening',r));webOrigin='http://127.0.0.1:'+appServer.address().port;
});
after(async()=>{await Promise.all([new Promise(r=>provider.close(r)),new Promise(r=>appServer.close(r))]);await db.close();});
beforeEach(async()=>{requests=[];posts=[];failAfterAccept=false;invoiceOverrides={};customerOverrides={};historical=[];await db.exec('truncate rook_acq_documents,rook_acq_outbox,rook_acq_commissions,rook_acq_events,rook_acq_blocks');await store.call('put',{kind:'config',id:'launch',body:{baselineComplete:true,goLiveAt:new Date(NOW-86400000).toISOString()}});await store.call('enroll',{id:'partner',userId:'partner-user',identityHash:signed.identity('partner@example.test'),status:'active'});await store.call('bind',{userId:'buyer',identityHash:signed.identity('buyer@example.test'),partnerId:'partner',boundAt:new Date(NOW-3600000).toISOString(),expiresAt:new Date(NOW+30*86400000).toISOString()});});
function adapter(approved=true){return createBufferAdapter({token:'LOCAL_CONTRACT_ONLY',linkedinChannelId:'li_rook',facebookChannelId:'fb_rook',liveApproved:approved,httpFetch:async(url,options)=>{assert.equal(url,'https://api.buffer.com');return fetch(origin+'/buffer',options);}});}
test('existing Buffer GraphQL adapter validates exact ROOK channels and submits both company services',async()=>{const a=adapter();assert.equal((await a.channels()).length,2);for(const channel of ['li_rook','fb_rook'])assert.equal((await a.publish({channel,payload:{text:'Useful career guidance https://rookcareers.com/resources/'}})).status,'published');assert.equal(posts.length,2);});
test('Buffer adapter refuses publishing without explicit launch flag',async()=>{await assert.rejects(adapter(false).publish({channel:'li_rook',payload:{text:'x'}}),/disabled/);assert.equal(posts.length,0);});
test('Buffer rejects personal and unrelated project destinations',async()=>{await assert.rejects(adapter().publish({channel:'buzz',payload:{text:'x'}}),/Unapproved/);await assert.rejects(adapter().publish({channel:'personal',payload:{text:'x'}}),/Unapproved/);assert.equal(posts.length,0);});
test('Buffer timeout after accepting post reconciles by exact content and channel',async()=>{const a=adapter(),row={channel:'li_rook',payload:{text:'Unique fixture guidance https://rookcareers.com/resources/?rook_post=unique'}};failAfterAccept=true;await assert.rejects(a.publish(row));failAfterAccept=false;const r=await a.reconcile(row);assert.equal(r.status,'published');assert.equal(posts.length,1);});
test('Buffer unknown receipt never asserts authoritative absence',async()=>{assert.equal((await adapter().reconcile({channel:'li_rook',payload:{text:'unseen'}})).status,'unknown');});
function event(overrides={}){return {id:'evt_sdk_contract',object:'event',livemode:false,type:'invoice.paid',data:{object:{id:'in_new',object:'invoice'}},...overrides};}
async function webhook(e,signature=true){const body=JSON.stringify(e);const sig=signature?stripe.webhooks.generateTestHeaderString({payload:body,secret}):'invalid';return fetch(webOrigin+'/api/acquisition/stripe-webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':sig},body});}
test('Stripe SDK signature verification and canonical REST reads accrue one commission end to end',async()=>{assert.equal((await webhook(event())).status,200);assert.equal((await store.call('commissions')).length,1);assert.equal((await webhook(event())).status,200);assert.equal((await store.call('commissions')).length,1);assert.ok(requests.filter(r=>r.path.startsWith('/v1/')).every(r=>r.method==='GET'));});
test('forged signature and live-mode event are rejected before Stripe retrieval',async()=>{assert.equal((await webhook(event(),false)).status,400);assert.equal((await webhook(event({livemode:true}))).status,400);assert.equal(requests.length,0);});
test('forged invoice amount in event cannot override canonical Stripe invoice',async()=>{const e=event();e.data.object.amount_paid=999999;invoiceOverrides={amount_paid:0};await webhook(e);assert.equal((await store.call('commissions')).length,0);});
test('paid out-of-band and mismatched customer identity never accrue',async()=>{invoiceOverrides={paid_out_of_band:true};await webhook(event());assert.equal((await store.call('commissions')).length,0);invoiceOverrides={};customerOverrides={email:'different@example.test'};await webhook(event({id:'evt_mismatch'}));assert.equal((await store.call('commissions')).length,0);});
test('renewal invoice cannot generate a first-purchase commission',async()=>{invoiceOverrides={billing_reason:'subscription_cycle'};await webhook(event());assert.equal((await store.call('commissions')).length,0);});
test('Stripe refund event reverses held commission through canonical charge lookup',async()=>{await webhook(event());await webhook(event({id:'evt_refund',type:'charge.refunded',data:{object:{id:'ch_in_new',object:'charge'}}}));assert.equal((await store.call('commissions'))[0].status,'reversed');});
test('baseline reconciles and protects three existing monthly customers',async()=>{const b=await observer.baseline();assert.equal(b.excludedCustomers,3);assert.equal((await store.call('list',{kind:'baseline'})).length,3);});
test('revenue dashboard distinguishes introductory payment from full-price subscriber count',async()=>{const m=await observer.metrics();assert.equal(m.activePayingSubscribers,4);assert.equal(m.fullPricePlanSubscribers,3);assert.equal(m.normalizedMrrCents,7996);assert.equal(m.targetSubscribers,51);});
test('daily canonical reconciliation recovers a missed payment webhook',async()=>{const r=await observer.reconcile();assert.equal(r.checked,1);assert.equal((await store.call('commissions')).length,1);await observer.reconcile();assert.equal((await store.call('commissions')).length,1);});
test('returning monthly customer on a historic ROOK price is excluded',async()=>{historical=[{...invoice('in_historic'),created:Math.floor(NOW/1000)-864000,lines:list([{price:{id:'price_retired',product:'prod_rook',recurring:{interval:'month'}}}])}];await webhook(event());assert.equal((await store.call('commissions')).length,0);});
test('nonpublic Buffer integration probe creates drafts and cleans up only its own IDs',async()=>{const r=await require('./bufferDraftCheck').verifyDrafts({token:'LOCAL_ONLY',linkedinChannelId:'li_rook',facebookChannelId:'fb_rook',confirm:true,httpFetch:async(url,options)=>{assert.equal(url,'https://api.buffer.com');const payload=JSON.parse(options.body);if(payload.query.includes('CreatePost')){assert.equal(payload.variables.input.saveToDraft,true);assert.equal(payload.variables.input.mode,'addToQueue');}return fetch(origin+'/buffer',options);}});assert.equal(r.results.length,2);assert.equal(r.cleanupConfirmed,true);assert.equal(r.publicPublicationTested,false);assert.equal(posts.length,0);});

test('existing ROOK publication defers a different post before any mutation',async()=>{posts.push({id:'existing',channelId:'li_rook',text:'Existing ROOK campaign',status:'sent',sentAt:new Date().toISOString()});await assert.rejects(adapter().publish({channel:'li_rook',payload:{text:'Different acquisition campaign'}}),e=>e.definitelyNotAccepted===true&&/occupies/.test(e.message));assert.equal(posts.length,1);});
