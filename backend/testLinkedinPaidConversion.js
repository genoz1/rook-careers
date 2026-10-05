const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const li=require('./linkedinPaidConversion');
const {handleStripeWebhookEvent}=require('./routes/stripe');
const secret='mock-test-only-secret';
const profile={user_id:'mock-user',email:' Candidate@Example.test ',trial_source:'v9',utm_source:'linkedin',utm_medium:'paid-social',utm_campaign:'test',utm_content:'creative',utm_term:'medical-sales',utm_id:'campaign-id'};
const invoice={id:'in_first',customer:'cus_mock',subscription:'sub_mock',billing_reason:'subscription_create',status:'paid',amount_paid:999,currency:'usd',status_transitions:{paid_at:100}};
function harness({fetchFailure=false,writeFailure=false,accountProfile=profile}={}) {
 const rows=new Map(),requests=[],conversions=new Set();let failFetch=fetchFailure,failWrite=writeFailure;
 const fetchImpl=async(url,options)=>{
  const payload=JSON.parse(options.body);requests.push(payload);
  assert.equal(url,'https://api.linkedin.com/rest/conversionEvents');assert.equal(options.headers.Authorization,'Bearer '+secret);
  if(failFetch){failFetch=false;return {status:503};}
  conversions.add(payload.eventId);return {status:201};
 };
 const db={from:table=>{
  if(table==='candidate_profiles')return {select:()=>({eq:()=>({maybeSingle:async()=>({data:accountProfile})})})};
  return {
   insert:async row=>{if(rows.has(row.event_key))return {error:{code:'23505'}};rows.set(row.event_key,{...row});return {};},
   select:()=>({eq:(_,key)=>({maybeSingle:async()=>({data:rows.has(key)?{...rows.get(key)}:null})})}),
   update:values=>({eq:async(_,key)=>{if(failWrite){failWrite=false;return {error:{code:'mock'}};}Object.assign(rows.get(key),values);return {};}})
  };
 }};
 const dispatch=async(data=invoice,type='invoice.paid')=>{
  const prior=process.env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN;process.env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN=secret;
  try{return await handleStripeWebhookEvent({type,created:100,data:{object:data}}, {supabaseAdmin:db,subscriberNotifier:async()=>{},linkedinDelivery:args=>li.deliverPaidConversion({...args,env:{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret},fetchImpl})});}
  finally{if(prior===undefined)delete process.env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN;else process.env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN=prior;}
 };
 return {rows,requests,conversions,dispatch};
}
test('first paid V9 LinkedIn invoice sends once; duplicate webhooks and renewals do not send',async()=>{
 const h=harness();assert.equal((await h.dispatch()).applied,true);
 await h.dispatch();await h.dispatch(invoice,'invoice.payment_succeeded');
 await h.dispatch({...invoice,id:'in_renewal',billing_reason:'subscription_cycle',amount_paid:1999});
 assert.equal(h.requests.length,1);assert.equal(h.conversions.size,1);assert.equal(h.rows.size,1);
 const p=h.requests[0],row=[...h.rows.values()][0];
 assert.equal(p.conversion,'urn:lla:llaPartnerConversion:31096658');assert.equal(p.conversionHappenedAt,100000);
 assert.deepEqual(p.conversionValue,{currencyCode:'USD',amount:'9.99'});
 assert.equal(p.user.userIds[0].idValue,crypto.createHash('sha256').update('candidate@example.test').digest('hex'));
 assert(!JSON.stringify(p).includes('Candidate'));assert(!JSON.stringify(p).includes('mock-user'));assert(!JSON.stringify(p).includes(secret));
 assert(row.linkedin_sent_at);assert.equal(row.linkedin_invoice_id,'in_first');
 for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id'])assert.equal(row[key],profile[key]);
});
test('zero/open/non-subscription invoices never send; renewal alone is not acquisition',async()=>{
 for(const data of [{...invoice,amount_paid:0},{...invoice,status:'open'},{...invoice,subscription:null},{...invoice,billing_reason:'subscription_cycle'}]) {
  const h=harness();await h.dispatch(data);assert.equal(h.requests.length,0);
 }
 const h=harness();await h.dispatch({...invoice,subscription:null},'invoice.payment_failed');assert.equal(h.requests.length,0);
});
test('API failure is retryable after ledger insert and retry sends the original event once',async()=>{
 const h=harness({fetchFailure:true});await assert.rejects(h.dispatch(),/HTTP 503/);
 assert.equal(h.rows.size,1);await h.dispatch();await h.dispatch();
 assert.equal(h.requests.length,2);assert.equal(h.conversions.size,1);assert.equal(h.requests[0].eventId,h.requests[1].eventId);
});
test('receipt-write failure reuses LinkedIn eventId after successful API acceptance',async()=>{
 const h=harness({writeFailure:true});await assert.rejects(h.dispatch(),/receipt write failed/);
 await h.dispatch();await h.dispatch();assert.equal(h.requests.length,2);assert.equal(h.conversions.size,1);
});
test('concurrent duplicate requests use the same LinkedIn eventId',async()=>{
 const record={event_key:'first_paid_mock-user',event_type:'paid_subscription_started',occurred_at:new Date(100000).toISOString(),...li.receiptFields(profile,invoice,{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret})};
 const ids=new Set();const fetchImpl=async(_,options)=>{ids.add(JSON.parse(options.body).eventId);return {status:201};};
 await Promise.all([1,2].map(()=>li.sendPaidConversion({record,invoice,env:{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret},fetchImpl})));
 assert.equal(ids.size,1);
});
test('Meta, Google, V8, organic and historical ledger rows are never backfilled',async()=>{
 for(const p of [{...profile,utm_source:'facebook'},{...profile,utm_source:'google'},{...profile,utm_source:null},{...profile,trial_source:'v8'}]){
  const h=harness({accountProfile:p});await h.dispatch();assert.equal(h.requests.length,0);assert(!([...h.rows.values()][0].linkedin_invoice_id));
 }
 const h=harness();h.rows.set('first_paid_mock-user',{event_key:'first_paid_mock-user',event_type:'paid_subscription_started'});
 await h.dispatch();assert.equal(h.requests.length,0);
});
test('missing secret is inert; missing matching data fails closed; network errors are sanitized',async()=>{
 assert.deepEqual(li.receiptFields(profile,invoice,{}),{});
 assert.throws(()=>li.receiptFields({...profile,email:''},invoice,{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret}),/missing/);
 const record={event_key:'first_paid_mock-user',event_type:'paid_subscription_started',occurred_at:new Date(100000).toISOString(),...li.receiptFields(profile,invoice,{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret})};
 assert.deepEqual(await li.sendPaidConversion({record,invoice,env:{}}),{sent:false});
 await assert.rejects(li.sendPaidConversion({record,invoice,env:{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret},fetchImpl:async()=>{throw Error(secret);}}),e=>e.message==='LinkedIn paid-conversion delivery unavailable');
});
test('read-only authorization check verifies exact account and conversion without POST',async()=>{
 const fetchImpl=async(url,options)=>{assert.equal(options.method,'GET');assert(url.endsWith('/31096658'));return {ok:true,json:async()=>({id:31096658,account:'urn:li:sponsoredAccount:557944801'})};};
 assert.deepEqual(await li.verifyAuthorization({env:{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret},fetchImpl}),{authorized:true,account:'557944801',conversion:'31096658'});
 await assert.rejects(li.verifyAuthorization({env:{LINKEDIN_CONVERSIONS_ACCESS_TOKEN:secret},fetchImpl:async()=>({ok:false,status:403})}),/HTTP 403/);
});
test('additive receipt migration is idempotent and preserves the first-party ledger',async()=>{
 const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
 await db.exec("create table ad_conversion_events(event_key text);insert into ad_conversion_events values ('existing');");
 const sql=fs.readFileSync('backend/db/linkedin-paid-conversion.sql','utf8');await db.exec(sql);await db.exec(sql);
 const {rows}=await db.query('select * from ad_conversion_events');assert.equal(rows[0].event_key,'existing');assert.equal(rows[0].linkedin_invoice_id,null);await db.close();
});
