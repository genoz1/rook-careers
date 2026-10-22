'use strict';
const {digest}=require('./security');
function batchDigest(batch){return digest(JSON.stringify({id:batch.id,recipients:batch.recipients}));}
async function reviewBatch(store,id){
 const batch=await store.call('get',{kind:'batch',id});if(!batch)throw Error('Payout batch not found');
 const commissions=await store.call('commissions');
 for(const recipient of batch.recipients){
  const rows=commissions.filter(c=>c.batch_id===id&&c.partner_id===recipient.partnerId&&c.status==='batched');
  const invoices=rows.map(c=>c.invoice_id).sort();
  if(recipient.amountCents<1000||rows.reduce((a,c)=>a+c.amount_cents,0)!==recipient.amountCents||JSON.stringify(invoices)!==JSON.stringify([...recipient.invoices].sort()))throw Error('Batch changed or commission reversed; payment approval invalid');
 }
 return {...batch,digest:batchDigest(batch),totalCents:batch.recipients.reduce((a,r)=>a+r.amountCents,0),paymentEnabled:false,requirements:['Approved payout policy and provider account','Verified payee onboarding and tax details','Revalidate this immutable digest immediately before submission','Idempotent provider submission and authoritative receipt reconciliation']};
}
module.exports={reviewBatch,batchDigest};
