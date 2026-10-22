'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyDrafts}=require('./bufferDraftCheck');
const {verifySimulator}=require('./resendSimulatorCheck');
function bufferFixture({failDelete=false,failRead=false}={}) {
 const posts=new Map(),deleted=[],inputs=[];
 const httpFetch=async(url,opts)=>{
  assert.equal(url,'https://api.buffer.com');
  const {query,variables}=JSON.parse(opts.body),i=variables?.input;let data;
  if(query.includes('GetCompanyChannel'))data={channel:{id:variables.id,name:'ROOK Careers',service:variables.id==='li'?'linkedin':'facebook',organizationId:'org',type:'page',allowedActions:['scheduleUpdates'],isDisconnected:false,isLocked:false,isQueuePaused:false}};
  else if(query.includes('GetOrganizations'))data={account:{organizations:[{id:'org'}]}};
  else if(query.includes('GetChannels'))data={channels:[{id:'li',name:'ROOK Careers',service:'linkedin'},{id:'fb',name:'ROOK Careers',service:'facebook'}]};
  else if(query.includes('mutation CreatePost')){inputs.push(i);const p={id:'draft-'+inputs.length,channelId:i.channelId,text:i.text,status:'draft'};posts.set(p.id,p);data={createPost:{post:p}};}
  else if(query.includes('ReadDiagnosticDraft')){if(failRead)throw Error('read timeout');data={post:posts.get(i.id)};}
  else if(query.includes('DeleteDraft')){deleted.push(i.id);if(failDelete&&i.id==='draft-1')throw Error('cleanup timeout');posts.delete(i.id);data={deletePost:{__typename:'DeletePostSuccess'}};}
  else throw Error('Unexpected operation');
  return {ok:true,json:async()=>({data}),text:async()=>JSON.stringify({data})};
 };
 return {httpFetch,posts,deleted,inputs};
}
const bufferArgs={token:'fixture-only',linkedinChannelId:'li',facebookChannelId:'fb',confirm:true};
test('probe reads back two nonpublic drafts and deletes exactly its own receipts',async()=>{const f=bufferFixture();const r=await verifyDrafts({...bufferArgs,httpFetch:f.httpFetch});assert.equal(r.cleanupCount,2);assert.equal(r.cleanupConfirmed,true);assert.equal(f.posts.size,0);for(const i of f.inputs){assert.equal(i.saveToDraft,true);assert.equal(i.mode,'addToQueue');assert.equal(i.needsApproval,false);assert.equal(i.dueAt,undefined);}assert.ok(r.results.every(r=>r.readbackConfirmed));});
test('cleanup failure does not skip remaining draft deletion',async()=>{const f=bufferFixture({failDelete:true});await assert.rejects(verifyDrafts({...bufferArgs,httpFetch:f.httpFetch}),/cleanup incomplete/);assert.deepEqual(f.deleted,['draft-1','draft-2']);assert.equal(f.posts.size,1);});
test('readback failure still deletes the created draft and stops further creation',async()=>{const f=bufferFixture({failRead:true});await assert.rejects(verifyDrafts({...bufferArgs,httpFetch:f.httpFetch}),/read timeout/);assert.equal(f.inputs.length,1);assert.deepEqual(f.deleted,['draft-1']);assert.equal(f.posts.size,0);});
test('draft confirmation is mandatory before any request',async()=>{await assert.rejects(verifyDrafts({httpFetch:()=>assert.fail('unexpected request')}),/confirmation/);});
function resendFixture(events=['sent','delivered']){let args,reads=0;return {send:async a=>{args=a;assert.match(a.to,/^delivered\+rook-acq-[a-f0-9-]+@resend\.dev$/);assert.ok(a.idempotencyKey);assert.equal(a.replyTo,undefined);return {id:'email-fixture'};},httpFetch:async(url,opts)=>{assert.equal(url,'https://api.resend.com/emails/email-fixture');assert.equal(opts.method,'GET');return {ok:true,json:async()=>({id:'email-fixture',to:[args.to],subject:args.subject,last_event:events[Math.min(reads++,events.length-1)]})};},pause:async()=>{},token:'fixture-only',confirm:true};}
test('Resend fixed simulator polls its own receipt until delivered',async()=>{const r=await verifySimulator(resendFixture());assert.equal(r.simulatedDeliveryConfirmed,true);assert.equal(r.realProspectDeliveryTested,false);assert.equal(r.webhookDeliveryTested,false);});
test('accepted receipt without delivery event is not reported as delivery',async()=>{const r=await verifySimulator(resendFixture(['sent']));assert.equal(r.accepted,true);assert.equal(r.simulatedDeliveryConfirmed,false);});
test('mismatched simulator readback fails closed',async()=>{const f=resendFixture();f.httpFetch=async()=>({ok:true,json:async()=>({id:'email-fixture',subject:'mismatch',to:['real@example.test'],last_event:'delivered'})});await assert.rejects(verifySimulator(f),/mismatch/);});
test('simulator requires explicit confirmation and existing credential before sending',async()=>{await assert.rejects(verifySimulator({send:()=>assert.fail('send')}),/confirmation/);await assert.rejects(verifySimulator({confirm:true,token:'',send:()=>assert.fail('send')}),/credential/);});
