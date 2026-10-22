'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {dispatchPartnerEmail}=require('./emailWorker');
const {readEmailReceipt}=require('./resendReceipt');
const {health}=require('./worker');
const NOW=Date.now();
function fixture(status='ready',receipt){
 let outcome,sends=0;const writes=[];
 const row={id:'email-slot',status,receipt,created_at:new Date(NOW-25*3600000).toISOString(),payload:{partnerId:'partner',stage:'welcome'}};
 const store={call:async(op,a)=>{if(op==='claim')return row;if(op==='get')return a.kind==='partner'?{email:'consenting-fixture@example.test',emailVerified:true,marketingConsent:true,status:'active',id:'partner',identityHash:'fixture-hash'}:null;if(op==='outcome'){outcome=a;return {ok:true};}if(op==='put'){writes.push(a);return a.body;}throw Error('Unexpected op');}};
 return {store,writes,get outcome(){return outcome;},get sends(){return sends;},args:{enabled:true,postalAddress:'Synthetic fixture address',now:NOW,signer:{sign:()=> 'fixture-token'},send:async()=>{sends++;return {id:'receipt-fixture'};}}};
}
test('accepted email is not called delivered at submission',async()=>{const f=fixture();const r=await dispatchPartnerEmail(f.store,f.args);assert.equal(r.status,'provider_accepted');assert.equal(f.outcome.status,'accepted');assert.equal(f.sends,1);});
test('old accepted receipt is reconciled by GET without any resend',async()=>{const f=fixture('accepted',{id:'receipt-fixture'});const r=await dispatchPartnerEmail(f.store,{...f.args,read:async id=>({id,status:'delivered'})});assert.equal(r.status,'delivered');assert.equal(f.outcome.status,'published');assert.equal(f.sends,0);});
test('receipt timeout never triggers resend or claims delivery',async()=>{const f=fixture('accepted',{id:'receipt-fixture'});const r=await dispatchPartnerEmail(f.store,{...f.args,read:async()=>{throw Error('timeout');}});assert.equal(r.status,'uncertain');assert.equal(f.outcome.status,'uncertain');assert.equal(f.sends,0);});
test('provider failure suppresses future partner mail without a new send',async()=>{const f=fixture('uncertain',{id:'receipt-fixture'});await dispatchPartnerEmail(f.store,{...f.args,read:async id=>({id,status:'failed'})});assert.equal(f.outcome.status,'suppressed');assert.equal(f.writes[0].kind,'suppression');assert.equal(f.sends,0);});
test('uncertain send without receipt beyond idempotency window stays uncertain',async()=>{const f=fixture('working');await dispatchPartnerEmail(f.store,f.args);assert.equal(f.outcome.status,'uncertain');assert.equal(f.sends,0);});
test('email rows cannot inflate social publication totals',async()=>{const h=await health({call:async()=>[{lane:'social',status:'published'},{lane:'permissioned_email',status:'published'},{lane:'permissioned_email',status:'accepted'}]});assert.equal(h.published,1);assert.equal(h.uncertain,0);});
test('receipt client uses GET only and sanitizes provider data',async()=>{const r=await readEmailReceipt('receipt-fixture',{token:'fixture-only',httpFetch:async(url,o)=>{assert.equal(url,'https://api.resend.com/emails/receipt-fixture');assert.equal(o.method,'GET');return {ok:true,json:async()=>({id:'receipt-fixture',last_event:'delivered',to:['private-fixture@example.test'],html:'private'})};}});assert.deepEqual(r,{id:'receipt-fixture',status:'delivered'});});

test('uncertain retries keep identical idempotent content inside the safe window',async()=>{
 const f=fixture('uncertain');f.store.call=(orig=>async(op,a)=>{const r=await orig(op,a);if(op==='claim')r.created_at=new Date(NOW-3600000).toISOString();return r;})(f.store.call);
 const sent=[];const args={...f.args,send:async a=>{sent.push(a);return {id:'receipt-fixture'};}};
 await dispatchPartnerEmail(f.store,args);await dispatchPartnerEmail(f.store,{...args,now:NOW+3600000});assert.equal(sent.length,2);assert.equal(sent[0].idempotencyKey,sent[1].idempotencyKey);assert.equal(sent[0].html,sent[1].html);
});
