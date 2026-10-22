'use strict';
const crypto=require('node:crypto');
const {escape:esc}=require('./security');
async function dispatchPartnerEmail(store,{signer,send,read,postalAddress,enabled=false,now=Date.now()}){
 if(!enabled||!postalAddress)return null;
 const token=crypto.randomUUID();const row=await store.call('claim',{lane:'permissioned_email',token,now:new Date(now).toISOString()});if(!row)return null;
 const done=(status,error=null,receipt=null)=>store.call('outcome',{id:row.id,token,status,error,receipt,dueAt:new Date(now+3600000).toISOString()});
 const p=await store.call('get',{kind:'partner',id:row.payload.partnerId});
 if(!p||!p.emailVerified||!p.marketingConsent||p.status!=='active'||await store.call('get',{kind:'suppression',id:p.identityHash})){await done('suppressed');return {status:'suppressed'};}
 // A saved acceptance receipt is reconciled by GET, never by another send.
 if(row.receipt?.id&&['working','uncertain','accepted'].includes(row.status)){
  try{
   if(!read)throw Error('Email receipt reader unavailable');
   const r=await read(row.receipt.id);
   if(r?.id!==row.receipt.id||!['delivered','failed','accepted'].includes(r.status))throw Error('Email receipt unresolved');
   if(r.status==='failed')await store.call('put',{kind:'suppression',id:p.identityHash,body:{reason:'email_provider_failure',at:new Date(now).toISOString()}});
   await done(r.status==='delivered'?'published':r.status==='failed'?'suppressed':'accepted',null,r);
   return {status:r.status};
  }catch{await done('uncertain','email_receipt_requires_reconciliation');return {status:'uncertain'};}
 }
 // Resend idempotency keys expire. Never blindly resend after the 24h window.
 if(['working','uncertain','accepted'].includes(row.status)&&now-Date.parse(row.created_at)>23*3600000){await done('uncertain','email_receipt_requires_reconciliation');return {status:'uncertain'};}
 const unsubscribe='https://rookcareers.com/partners/unsubscribe?token='+signer.sign({purpose:'unsubscribe',identityHash:p.identityHash,exp:Date.parse(row.created_at)+365*86400000});
 const link='https://rookcareers.com/r/'+p.id;
 try{
  const r=await send({to:p.email,subject:row.payload.stage==='welcome'?'Your ROOK referral link and disclosure':'A useful way to share ROOK with your audience',idempotencyKey:row.id,html:`<h1>ROOK partner resources</h1><p>You requested ROOK partner onboarding and tips. Your referral link: <a href="${link}">${link}</a>.</p><p>Share useful career guidance with your own audience. Example disclosure: “I may earn a $5 commission if you become a new paying ROOK monthly subscriber through this link.”</p><p>Read <a href="https://rookcareers.com/resources/how-to-write-a-medical-sales-resume/">medical sales resume guidance</a> or the <a href="https://rookcareers.com/partners/">program rules</a>. Do not send unsolicited invitations or disclose protected jobs.</p><p>ROOK Careers · ${esc(postalAddress)} · <a href="${esc(unsubscribe)}">Unsubscribe</a></p>`});
  if(!r?.id)throw Error('No email receipt');await done('accepted',null,{id:r.id,status:'provider_accepted'});return {status:'provider_accepted'};
 }catch(e){const certain=!['working','uncertain','accepted'].includes(row.status)&&e.definitelyNotAccepted===true;await done(certain?'retry':'uncertain',certain?'email_budget_or_rejection':'email_delivery_uncertain');return {status:certain?'retry':'uncertain'};}
}
module.exports={dispatchPartnerEmail};
