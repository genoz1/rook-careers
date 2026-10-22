'use strict';
// Observation only. This module cannot create/update subscriptions, charge or refund.
function monthlyLine(line,priceId){const p=line.price||line.pricing?.price_details?.price;return (typeof p==='string'?p:p?.id)===priceId;}
function createStripeObserver({stripe,store,identity,monthlyPriceId,lookupProfile,clock=Date.now}){
 if(!monthlyPriceId)throw Error('Existing monthly Stripe price is required');
 let canonicalPrice;
 async function getPrice(){if(!canonicalPrice)canonicalPrice=await stripe.prices.retrieve(monthlyPriceId);return canonicalPrice;}
 async function paidMonthlyInvoices(customer){
  const currentPrice=await getPrice();
  const all=[];
  for await(const invoice of stripe.invoices.list({customer,status:'paid',limit:100})){
   if(!(invoice.amount_paid>0)||invoice.paid_out_of_band)continue;
   let lines=invoice.lines?.data||[];
   if(invoice.lines?.has_more){lines=[];for await(const l of stripe.invoices.listLineItems(invoice.id,{limit:100}))lines.push(l);}
   if(lines.some(l=>monthlyLine(l,monthlyPriceId)||(l.price?.recurring?.interval==='month'&&l.price?.product&&l.price.product===currentPrice.product)))all.push(invoice);
  }return all;
 }
 async function process(event){
  const obj=event.data.object;
  if(['charge.refunded','charge.dispute.created','charge.dispute.funds_withdrawn','refund.created','refund.updated','charge.dispute.closed'].includes(event.type)){
   const chargeId=obj.object==='charge'?obj.id:typeof obj.charge==='string'?obj.charge:obj.charge?.id;
   if(!chargeId)return {ignored:true,reason:'charge_unresolved'};
   const ch=await stripe.charges.retrieve(chargeId);
   const invoiceId=typeof ch.invoice==='string'?ch.invoice:ch.invoice?.id;
   // 2024 API retains charge.invoice. Unknown mapping is a reconciliation blocker.
   if(!invoiceId)throw Error('Refund invoice mapping unresolved');
   // Conservatively block any refund request or dispute, including pending refunds.
   return store.call('reverse',{invoiceId,reason:event.type});
  }
  if(!['invoice.paid','invoice.payment_succeeded'].includes(event.type))return {ignored:true};
  const inv=await stripe.invoices.retrieve(obj.id,{expand:['payment_intent','charge']});
  const customerId=typeof inv.customer==='string'?inv.customer:inv.customer?.id;
  const subId=typeof inv.subscription==='string'?inv.subscription:inv.subscription?.id||inv.parent?.subscription_details?.subscription;
  if(!subId||inv.status!=='paid'||!(inv.amount_paid>0)||inv.currency!=='usd'||inv.paid_out_of_band)return {ignored:true,reason:'not_verified_paid_subscription'};
  const [customer,subscription,profile,prior]=await Promise.all([stripe.customers.retrieve(customerId),stripe.subscriptions.retrieve(subId),lookupProfile(customerId),paidMonthlyInvoices(customerId)]);
  if(!profile?.userId||!profile.email)throw Error('Customer profile mapping pending reconciliation');
  if(customer.deleted||!customer.email||identity(customer.email)!==identity(profile.email))return {ignored:true,reason:'identity_unverified'};
  const price=await getPrice();
  if(price.unit_amount!==1999||price.currency!=='usd'||price.recurring?.interval!=='month'||price.recurring?.interval_count!==1)throw Error('Existing monthly price does not match preserved terms');
  if(!subscription.items.data.some(i=>i.price.id===monthlyPriceId))return {ignored:true,reason:'other_subscription'};
  prior.sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
  const charge=typeof inv.charge==='object'?inv.charge:inv.charge?await stripe.charges.retrieve(inv.charge):null;
  if(!charge||charge.paid!==true||charge.refunded||charge.disputed||charge.amount_refunded>0)return {ignored:true,reason:'payment_not_clear'};
  return store.call('paid',{eventId:event.id,eligible:prior[0]?.id===inv.id&&inv.billing_reason==='subscription_create',userId:profile.userId,customerId,identityHash:identity(profile.email),fingerprintHash:charge.payment_method_details?.card?.fingerprint?identity('payment:'+charge.payment_method_details.card.fingerprint):null,amountCents:inv.amount_paid,channel:typeof profile.channel==='string'?profile.channel.slice(0,80):'unattributed',invoiceId:inv.id,subscriptionId:subId,invoiceCreatedAt:new Date(inv.created*1000).toISOString(),paidAt:new Date((inv.status_transitions?.paid_at||inv.created)*1000).toISOString()});
 }
 async function baseline(){
  // Must complete before referrals can activate; all historical monthly payers excluded.
  const excluded=[];
  for await(const customer of stripe.customers.list({limit:100})){
   if(!customer.email)continue;
   const prior=await paidMonthlyInvoices(customer.id);if(!prior.length)continue;
   const profile=await lookupProfile(customer.id);
   const body={customerId:customer.id,identityHash:identity(customer.email),userId:profile?.userId||null};
   await store.call('put',{kind:'baseline',id:profile?.userId||customer.id,body});excluded.push(customer.id);
  }
  return {excludedCustomers:excluded.length,goLiveAt:new Date(clock()).toISOString(),baselineComplete:true};
 }
 async function reconcile(){
  const cfg=await store.call('get',{kind:'config',id:'launch'});if(!cfg?.baselineComplete)return {blocked:'baseline_required'};
  let checked=0;
  for await(const inv of stripe.invoices.list({status:'paid',created:{gte:Math.floor(Date.parse(cfg.goLiveAt)/1000)},limit:100})){
   if(!inv.lines?.data?.some(l=>monthlyLine(l,monthlyPriceId)))continue;
   await process({id:'reconciliation_'+inv.id,type:'invoice.paid',data:{object:{id:inv.id}}});checked++;
  }
  for(const c of await store.call('commissions')){
   if(!['held','batched','paid'].includes(c.status))continue;
   const inv=await stripe.invoices.retrieve(c.invoice_id,{expand:['charge']});const ch=typeof inv.charge==='string'?await stripe.charges.retrieve(inv.charge):inv.charge;
   if(ch&&(ch.refunded||ch.disputed||ch.amount_refunded>0))await store.call('reverse',{invoiceId:c.invoice_id,reason:'canonical_payment_reconciliation'});
  }
  return {checked};
 }
 async function metrics(){
  const subscriptions=[];let active=0,fullPrice=0,mrr=0,cancelling=0;const customers=new Set();
  for await(const sub of stripe.subscriptions.list({status:'all',limit:100,expand:['data.latest_invoice']})){
   const item=sub.items.data.find(i=>i.price.id===monthlyPriceId);if(!item)continue;
   const latest=typeof sub.latest_invoice==='string'?await stripe.invoices.retrieve(sub.latest_invoice):sub.latest_invoice;
   const verified=sub.status==='active'&&latest?.status==='paid'&&latest?.amount_paid>0&&!latest.paid_out_of_band;
   if(verified&&!customers.has(typeof sub.customer==='string'?sub.customer:sub.customer.id)){customers.add(typeof sub.customer==='string'?sub.customer:sub.customer.id);active++;if(item.price.unit_amount===1999&&item.quantity===1){if(latest.amount_paid>=1999)fullPrice++;const coupon=sub.discount?.coupon; mrr+=coupon&&coupon.duration!=='once'?Math.max(0,Math.round(1999*(1-(coupon.percent_off||0)/100))-(coupon.amount_off||0)):1999;}if(sub.cancel_at_period_end)cancelling++;}
   subscriptions.push({paid:latest?.status==='paid'&&latest?.amount_paid>0,id:sub.id,customerId:typeof sub.customer==='string'?sub.customer:sub.customer.id,status:sub.status,created:sub.created,canceledAt:sub.canceled_at||null,verifiedActive:verified,monthlyCents:verified?item.price.unit_amount*(item.quantity||1):0});
  }
  // MRR is normalized existing-price run rate; introductory invoices and cash receipts are separate.
  const result={newPaidSubscriptionStartsLast28Days:subscriptions.filter(s=>s.paid&&clock()/1000-s.created<28*86400).length,cancellationsLast28Days:subscriptions.filter(s=>s.canceledAt&&clock()/1000-s.canceledAt<28*86400).length,mrrDefinition:'Normalized contracted monthly run rate after recurring discounts; one-time introductory discounts are excluded. Not cash collected. Full-price subscriber count requires a latest paid invoice of at least $19.99.',capturedAt:new Date(clock()).toISOString(),activePayingSubscribers:active,activeFullPriceSubscribers:fullPrice,fullPricePlanSubscribers:fullPrice,normalizedMrrCents:mrr,cancellingAtPeriodEnd:cancelling,targetCents:100000,targetSubscribers:51,subscriptions};
  await store.call('put',{kind:'metrics',id:'stripe',body:result});return result;
 }
 return {process,baseline,metrics,reconcile};
}
module.exports={createStripeObserver,monthlyLine};
