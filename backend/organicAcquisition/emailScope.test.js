'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {createEmailWebhooks}=require('./emailWebhooks'),{signer}=require('./security');
async function send(t,event,{known=true,tamper=false}={}){
 const key=crypto.randomBytes(32),secret='whsec_'+key.toString('base64'),signed=signer('synthetic-local-signing-key-at-least-32'),calls=[];
 const store={call:async(op,a)=>{calls.push({op,a});if(op==='outbox')return known?[{lane:'email',receipt:{id:'email_own'}}]:[];if(op==='list')return[{body:{identityHash:signed.identity('partner@example.test')}}];return {};}};
 const app=express();app.use(createEmailWebhooks({store,signer:signed,secret,senderAddress:'hello@rookcareers.com',replyAddress:'partners@rookcareers.com'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const raw=JSON.stringify(event),ts=String(Math.floor(Date.now()/1000)),id='evt_synthetic',signature=crypto.createHmac('sha256',key).update(id+'.'+ts+'.'+raw).digest('base64');
 const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/acquisition/email-webhook',{method:'POST',headers:{'content-type':'application/json','svix-id':id,'svix-timestamp':ts,'svix-signature':'v1,'+signature},body:raw+(tamper?' ':'')});return {status:r.status,body:await r.json(),calls};
}
test('unrelated sender events cannot read or write ROOK acquisition records',async t=>{const r=await send(t,{type:'email.bounced',data:{from:'other@unrelated.example',to:['partner@example.test'],email_id:'email_own'}});assert.equal(r.status,200);assert.equal(r.body.ignored,true);assert.deepEqual(r.calls,[]);});
test('untracked member email cannot suppress partner outreach',async t=>{const r=await send(t,{type:'email.bounced',data:{from:'hello@rookcareers.com',to:['partner@example.test'],email_id:'email_member'}},{known:false});assert.equal(r.body.ignored,true);assert.equal(r.calls.some(c=>c.a?.kind==='suppression'),false);});
test('tracked ROOK partner bounce suppresses only the verified partner identity',async t=>{const r=await send(t,{type:'email.bounced',data:{from:'ROOK <hello@rookcareers.com>',to:['partner@example.test'],email_id:'email_own'}});assert.equal(r.status,200);assert.equal(r.calls.filter(c=>c.a?.kind==='suppression').length,1);assert.doesNotMatch(JSON.stringify(r.calls.filter(c=>c.a?.kind==='metrics')),/partner@example/);});
test('delivery events record confirmation provenance without claiming an untracked send',async t=>{const r=await send(t,{type:'email.delivered',data:{from:'hello@rookcareers.com',email_id:'simulator'}});assert.equal(r.status,200);assert.deepEqual(r.calls.map(c=>c.op),['put']);assert.equal(r.calls[0].a.body.type,'email.delivered');assert.equal(r.calls[0].a.body.eventHash.length,64);});
test('tampered webhook cannot write delivery or suppression records',async t=>{const r=await send(t,{type:'email.delivered',data:{from:'hello@rookcareers.com'}},{tamper:true});assert.equal(r.status,400);assert.deepEqual(r.calls,[]);});
test('reply routing ignores unrelated recipients before accessing partner data',async t=>{const r=await send(t,{type:'email.received',data:{from:'partner@example.test',to:['other@unrelated.example']}});assert.equal(r.body.ignored,true);assert.deepEqual(r.calls,[]);});
