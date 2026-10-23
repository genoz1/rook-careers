'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {previewDrafts}=require('./queueReview');
function fixture(){const docs=new Map();return {docs,call:async(op,a)=>{const key=a.kind+':'+a.id;if(op==='get')return docs.get(key)||null;if(op==='put'){docs.set(key,structuredClone(a.body));return a.body;}}};}
const channels=[{id:'company-li',service:'linkedin'},{id:'company-fb',service:'facebook'}];
test('lost provider response leaves a durable pending attempt and blocks another draft submission',async()=>{
 const store=fixture();let calls=0;const deps={lookup:async()=>channels,request:async()=>{calls++;throw Error('Connection lost after submission');}};
 await assert.rejects(previewDrafts({store},{},deps),/Connection lost/);
 assert.equal(store.docs.get('config:marketing-review-drafts').attempt.candidateId,'opportunity-florida');
 await assert.rejects(previewDrafts({store},{},deps),/Reconcile existing/);assert.equal(calls,1);
});
test('a returned receipt is retained even if the provider reports an unexpected state',async()=>{
 const store=fixture();const deps={lookup:async()=>channels,request:async()=>({createPost:{post:{id:'provider-receipt',status:'scheduled',channelId:'company-li'}}})};
 await assert.rejects(previewDrafts({store},{},deps),/Unexpected draft state/);
 const record=store.docs.get('config:marketing-review-drafts');assert.equal(record.created[0].id,'provider-receipt');assert.equal(record.attempt,undefined);
 await assert.rejects(previewDrafts({store},{},deps),/Reconcile existing/);
});
test('an explicit provider rejection is reported without inventing a successful draft receipt',async()=>{
 const store=fixture();await assert.rejects(previewDrafts({store},{},{lookup:async()=>channels,request:async()=>({createPost:{__typename:'InvalidInputError',message:'Link attachment URL is unavailable'}})}),/Buffer rejected diagnostic: Link attachment URL is unavailable/);
 const record=store.docs.get('config:marketing-review-drafts');assert.equal(record.created.length,0);assert.equal(record.attempt,null);
});
