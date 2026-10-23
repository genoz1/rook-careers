'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {previewDrafts}=require('./queueReview');
function fixture(){const docs=new Map();return {docs,call:async(op,a)=>{const key=a.kind+':'+a.id;if(op==='get')return docs.get(key)||null;if(op==='put'){docs.set(key,structuredClone(a.body));return a.body;}}};}
const channels=[{id:'company-li',service:'linkedin'},{id:'company-fb',service:'facebook'}];
test('resuming reconciles each recorded nonpublic receipt before creating any remaining draft',async()=>{
 const store=fixture(),paused=channels.map(c=>({...c,isQueuePaused:true})),items=await require('./queueReview').select(store,paused),saved=items.slice(0,4).map((x,i)=>({id:'draft-'+i,channel:x.channel.id,candidateId:x.candidate.id}));
 store.docs.set('config:marketing-review-drafts',{created:saved,complete:false});let reads=0,creates=0;const returned=new Map();
 const deps={resume:true,lookup:async()=>paused,request:async(token,q,input)=>{if(q.includes('mutation')){assert.ok(reads>=4);creates++;const post={id:'new-'+creates,status:'draft',channelId:input.channelId,text:input.text,assets:input.assets.map(a=>({source:a.image.url})),metadata:{linkAttachment:input.metadata.facebook?.linkAttachment||input.metadata.linkedin?.linkAttachment}};if(post.metadata.linkAttachment)post.metadata.linkAttachment={...post.metadata.linkAttachment,thumbnail:post.metadata.linkAttachment.thumbnail.url};returned.set(post.id,post);return {createPost:{post}};}reads++;if(returned.has(input.id))return {post:returned.get(input.id)};const index=saved.findIndex(x=>x.id===input.id),x=items[index];return {post:{id:input.id,status:'draft',channelId:x.channel.id,text:x.payload.text,assets:[{source:x.payload.imageUrl}],metadata:{linkAttachment:{url:x.payload.shortUrl,thumbnail:x.payload.imageUrl}}}};}};
 const result=await previewDrafts({store},{},deps);assert.equal(result.drafts.length,10);assert.equal(creates,6);
});
test('resuming refuses missing, modified or published receipts and cannot bypass a pending attempt',async()=>{
 const store=fixture(),paused=channels.map(c=>({...c,isQueuePaused:true})),items=await require('./queueReview').select(store,paused);store.docs.set('config:marketing-review-drafts',{created:[{id:'known',channel:channels[0].id,candidateId:items[0].candidate.id}]});let creates=0;
 const deps={resume:true,lookup:async()=>paused,request:async(token,q)=>{if(q.includes('mutation'))creates++;return {post:{id:'known',status:'sent',channelId:channels[0].id,text:items[0].payload.text}};}};
 await assert.rejects(previewDrafts({store},{},deps),/did not reconcile/);assert.equal(creates,0);store.docs.get('config:marketing-review-drafts').attempt={channel:channels[0].id};await assert.rejects(previewDrafts({store},{},deps),/Reconcile existing/);assert.equal(creates,0);
});
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
