'use strict';
// OPTIONAL REAL STRIPE TEST-MODE CHECK. Never accepts a live key or touches existing objects.
// No database credentials required: real Stripe reads/writes + local embedded Postgres ledger.
require('dotenv').config();
const fs=require('node:fs'),crypto=require('node:crypto');
async function run(){
 const key=process.env.ACQ_STRIPE_TEST_SECRET_KEY;
 if(!key?.startsWith('sk_test_')||!process.argv.includes('--confirm-stripe-test-fixtures'))throw Error('A dedicated Stripe test key and explicit fixture confirmation are required');
 const stripe=new(require('stripe'))(key,{apiVersion:'2024-06-20',timeout:20000,maxNetworkRetries:1});
 const account=await stripe.accounts.retrieve();
 if(account.id!=='acct_1U8UeFAqONBF0tIy')throw Error('Unexpected ROOK sandbox account');
 const {PGlite}=require('@electric-sql/pglite'),{PostgresAcquisitionStore}=require('../backend/organicAcquisition/store'),{signer}=require('../backend/organicAcquisition/security');
 const db=new PGlite();await db.exec(fs.readFileSync(require.resolve('../backend/organicAcquisition/schema.sql'),'utf8'));const store=new PostgresAcquisitionStore(db),signed=signer(crypto.randomBytes(32).toString('hex'));
 const tag='rook_acq_test_'+crypto.randomUUID(),email=tag+'@example.test';let subscription,customer,product,price,result;
 try{
  product=await stripe.products.create({name:'ROOK acquisition TEST ONLY',metadata:{rook_test_run:tag}});
  price=await stripe.prices.create({product:product.id,unit_amount:1999,currency:'usd',recurring:{interval:'month'},metadata:{rook_test_run:tag}});
  customer=await stripe.customers.create({email,metadata:{rook_test_run:tag}});
  const pm=await stripe.paymentMethods.attach('pm_card_visa',{customer:customer.id});
  const start=Date.now();await store.call('put',{kind:'config',id:'launch',body:{baselineComplete:true,goLiveAt:new Date(start-60000).toISOString()}});
  await store.call('enroll',{id:'test-partner',userId:'test-partner-user',identityHash:signed.identity('test-partner@example.test'),status:'active'});
  await store.call('bind',{userId:'test-buyer',identityHash:signed.identity(email),partnerId:'test-partner',boundAt:new Date(start-60000).toISOString(),expiresAt:new Date(start+86400000).toISOString()});
  subscription=await stripe.subscriptions.create({customer:customer.id,items:[{price:price.id}],default_payment_method:pm.id,payment_behavior:'error_if_incomplete',metadata:{rook_test_run:tag}});
  const inv=typeof subscription.latest_invoice==='string'?subscription.latest_invoice:subscription.latest_invoice.id;
  const observer=require('../backend/organicAcquisition/stripeAdapter').createStripeObserver({stripe,store,identity:signed.identity,monthlyPriceId:price.id,lookupProfile:async()=>({userId:'test-buyer',email})});
  const evt={id:tag,type:'invoice.paid',data:{object:{id:inv}}};
  const signingSecret=crypto.randomBytes(32).toString('hex'),payload=JSON.stringify({...evt,livemode:false});
  const header=stripe.webhooks.generateTestHeaderString({payload,secret:signingSecret});
  if(stripe.webhooks.constructEvent(payload,header,signingSecret).id!==tag)throw Error('Signature verification failed');
  let rejected=false;try{stripe.webhooks.constructEvent(payload+' ',header,signingSecret);}catch{rejected=true;}if(!rejected)throw Error('Tampered signature accepted');
  await observer.process(evt);await observer.process({...evt,id:tag+'_duplicate'});
  const commissions=await store.call('commissions');if(commissions.length!==1||commissions[0].amount_cents!==500)throw Error('Real Stripe test invoice did not produce exactly one commission');
  const invoice=await stripe.invoices.retrieve(inv);const chargeId=typeof invoice.charge==='string'?invoice.charge:invoice.charge?.id;if(!chargeId)throw Error('Test invoice charge mapping unavailable');
  await stripe.refunds.create({charge:chargeId,metadata:{rook_test_run:tag}});
  await observer.process({id:tag+'_refund',type:'charge.refunded',data:{object:{id:chargeId,object:'charge'}}});
  if((await store.call('commissions'))[0].status!=='reversed')throw Error('Real Stripe test refund did not reverse commission');
  subscription=await stripe.subscriptions.cancel(subscription.id);
  if(subscription.status!=='canceled'||(await observer.metrics()).activePayingSubscribers!==0)throw Error('Cancellation still counted as active');
  result={passed:true,testMode:true,realStripeApi:true,commissionCents:500,duplicateProtected:true,refundReversed:true,cancellationExcluded:true,validSignatureAccepted:true,tamperedSignatureRejected:true,note:'Signature validation is local SDK validation. Remote webhook network delivery remains a separate check. No live subscription or payout was changed.'};
 }finally{
  const cleanup=await Promise.allSettled([
   subscription&&subscription.status!=='canceled'?stripe.subscriptions.cancel(subscription.id):Promise.resolve(),
   customer?stripe.customers.del(customer.id):Promise.resolve(),
   price?stripe.prices.update(price.id,{active:false}):Promise.resolve(),
   product?stripe.products.update(product.id,{active:false}):Promise.resolve(),
  ]);
  await db.close();
  if(cleanup.some(r=>r.status==='rejected'))throw Error('Sandbox fixture cleanup incomplete');
  if(result)console.log(JSON.stringify({...result,fixtureCleanupConfirmed:true},null,2));
 }
}
run().catch(()=>{console.error('Stripe test-mode check unavailable or failed. No live-key operation is permitted. Check dedicated test credentials and fixture cleanup.');process.exitCode=1;});
