const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {answersToProfile} = require('./v7Preview');
function visit(search, stored) {
  const memory = new Map(stored ? [['rook_attribution_v1', JSON.stringify(stored)]] : []);
  const ctx = {URLSearchParams, window:{location:{search}}, localStorage:{getItem:k=>memory.get(k), setItem:(k,v)=>memory.set(k,v)}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/rook-attribution.js','utf8'),ctx);
  return JSON.parse(JSON.stringify(ctx.rookGetStoredAttribution()));
}
assert.deepEqual(visit('?gclid=google-click'), {utm_source:'google',utm_medium:'cpc'});
assert.deepEqual(visit('?utm_source=reddit&utm_campaign=test'), {utm_source:'reddit',utm_campaign:'test'});
assert.deepEqual(visit('?gclid=new',{utm_source:'facebook'}), {utm_source:'facebook'});
const answer={location:{lat:42,lng:-71},industry:'Veterinary',years:3,territories:['local']};
assert.equal(answersToProfile({...answer,attribution:{utm_source:' google ',utm_campaign:'x'.repeat(300),email:'private'}}).utm_source,'google');
assert.equal(answersToProfile({...answer,attribution:{utm_campaign:'x'.repeat(300)}}).utm_campaign.length,200);
assert.equal(answersToProfile({...answer,attribution:{email:'private'}}).email,undefined);
const {handleStripeWebhookEvent}=require('./routes/stripe');
(async()=>{
 const rows=new Map();const profile={user_id:'user1',utm_source:'google',utm_medium:'cpc'};
 const db={from:table=> table==='candidate_profiles'?{select:()=>({eq:()=>({maybeSingle:async()=>({data:profile})})})}:{insert:async row=>{if(rows.has(row.event_key))return {error:{code:'23505'}};rows.set(row.event_key,row);return {};}}};
 const event=(id,amount,status='paid')=>({id,created:100,type:'invoice.payment_succeeded',data:{object:{id,customer:'cus1',subscription:'sub1',status,amount_paid:amount}}});
 assert.equal((await handleStripeWebhookEvent(event('zero',0),{supabaseAdmin:db})).applied,false);
 assert.equal((await handleStripeWebhookEvent(event('failed',1999,'open'),{supabaseAdmin:db})).applied,false);
 assert.equal((await handleStripeWebhookEvent(event('paid',1999),{supabaseAdmin:db})).applied,true);
 assert.equal((await handleStripeWebhookEvent(event('paid',1999),{supabaseAdmin:db})).applied,false);
 assert.equal((await handleStripeWebhookEvent(event('renewal',1999),{supabaseAdmin:db})).applied,false);
 assert.equal(rows.size,1);assert.equal([...rows.values()][0].utm_source,'google');
 console.log('PASS ad attribution: Google click source, first-touch persistence, allowlist, positive paid invoices, retry/renewal deduplication.');
})().catch(e=>{console.error(e);process.exitCode=1;});
