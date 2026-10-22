'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {PostgresAcquisitionStore}=require('./store');
const {createStripeObserver}=require('./stripeAdapter');
const {signer}=require('./security');
const {createRouter}=require('./routes');
const {reports,candidates}=require('./content');
const {reviewBatch}=require('./payouts');
const signed=signer('launch-safeguards-fixture-signing-key-32-characters');
test('$29 subscription with the same product cannot inflate the 51-subscriber target',async()=>{
 const price={id:'price_1999',product:'prod_rook',unit_amount:1999,currency:'usd',recurring:{interval:'month',interval_count:1}};
 const subs=[1999,1999,1999,2900].map((amount,i)=>({id:'sub_fixture_'+i,customer:'cus_fixture_'+i,status:'active',created:Math.floor(Date.now()/1000),items:{data:[{price:{...price,id:amount===1999?price.id:'price_29_separate',unit_amount:amount},quantity:1}]},latest_invoice:{status:'paid',amount_paid:amount}}));
 const stripe={subscriptions:{list:async function*(){yield* subs;}}};let saved;
 const observer=createStripeObserver({stripe,store:{call:async(op,a)=>{assert.equal(op,'put');saved=a.body;}},identity:signed.identity,monthlyPriceId:price.id,lookupProfile:async()=>assert.fail('Profile lookup unnecessary for metrics')});
 const m=await observer.metrics();assert.equal(m.activePayingSubscribers,3);assert.equal(m.activeFullPriceSubscribers,3);assert.equal(m.normalizedMrrCents,5997);assert.equal(m.targetSubscribers,51);assert.equal(m.subscriptions.length,3);assert.equal(saved,m);
});
test('private reporting and public content stay separate with protected sentinel records present',async()=>{
 const db=new PGlite();let server;
 try{
  await db.exec(fs.readFileSync(require.resolve('./schema.sql'),'utf8'));const store=new PostgresAcquisitionStore(db);
  const secret='PROTECTED_JOB_SENTINEL_NO_EXPORT';
  // Synthetic protected table is outside the sidecar, like the real member-only inventory.
  await db.exec('create table protected_fixture_jobs(title text, employer text, application_url text)');
  await db.query('insert into protected_fixture_jobs values($1,$1,$1)',[secret]);
  const snapshot=JSON.parse(fs.readFileSync(require.resolve('../../docs/organic-growth/baseline-inventory.json'),'utf8'));snapshot.capturedAt=new Date().toISOString();
  for(const c of snapshot.collections){c.suppressed=false;c.jobs=120;c.representedEmployers=12;}
  for(const r of reports(snapshot))await store.call('put',{kind:'report',id:r.slug,body:r});
  await store.call('put',{kind:'metrics',id:'stripe',body:{activeFullPriceSubscribers:3,normalizedMrrCents:5997,privateSentinel:secret}});
  let currentUser;const app=express();app.use(express.json());app.use(createRouter({store,signer:signed,authenticate:async()=>currentUser,adminEmails:['admin@example.test'],secureCookies:false}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
  for(const route of ['/partners/','/partners/dashboard/','/hiring-reports/','/hiring-reports/'+reports(snapshot)[0].slug+'/','/internal/acquisition']){const r=await fetch(origin+route);assert.equal(r.status,200);const html=await r.text();assert.ok(!html.includes(secret));assert.doesNotMatch(html,/application_url|protected_fixture_jobs|normalizedMrrCents/);}
  assert.equal((await fetch(origin+'/api/acquisition/admin')).status,401);
  currentUser={id:'member',email:'member@example.test',email_confirmed_at:new Date().toISOString()};assert.equal((await fetch(origin+'/api/acquisition/admin')).status,403);
  currentUser={id:'admin',email:'admin@example.test',email_confirmed_at:new Date().toISOString()};const r=await fetch(origin+'/api/acquisition/admin');assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.equal((await r.json()).stripe.activeFullPriceSubscribers,3);
  assert.equal((await db.query('select count(*)::int n from protected_fixture_jobs')).rows[0].n,1);
  assert.throws(()=>reports({...snapshot,jobRows:[{title:secret}]}),/Unexpected/);
  assert.ok(!JSON.stringify(candidates({...snapshot,jobRows:[{title:secret}]},Date.now())).includes(secret));
 }finally{if(server)await new Promise(r=>server.close(r));await db.close();}
});
test('payment preparation cannot authorize a payout',async()=>{
 const r=await reviewBatch({call:async(op)=>op==='get'?{id:'empty-fixture-batch',status:'awaiting_approval',recipients:[]}:[]},'empty-fixture-batch');
 assert.equal(r.paymentEnabled,false);assert.equal(r.status,'awaiting_approval');assert.equal(require('./runtime').createRuntime({ROOK_ACQUISITION_ENABLED:'false'}),null);
});
