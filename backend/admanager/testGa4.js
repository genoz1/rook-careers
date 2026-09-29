const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const {createReporter}=require('./ga4');
const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const env={GA4_PROPERTY_ID:'123',GA4_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'test@example.invalid',private_key:privateKey.export({type:'pkcs8',format:'pem'})})};
const row=(dims,metrics)=>({dimensionValues:dims.map(value=>({value})),metricValues:metrics.map(value=>({value:String(value)}))});
let calls=[];
const fetcher=async(url,opts)=>{
 calls.push({url,opts});
 if(url.includes('oauth2'))return {ok:true,json:async()=>({access_token:'private-token',expires_in:3600})};
 return {ok:true,json:async()=>({reports:[{rows:[row([],[100,120,80])],metadata:{timeZone:'America/New_York'}},{rows:[row(['v8_signup_started'],[30,20]),row(['sign_up'],[50,20])]},{rows:[row(['google / cpc','campaign'],[40,30])],rowCount:101},{rows:[row(['google / cpc','campaign','sign_up'],[10])],metadata:{subjectToThresholding:true}}]})};
};
(async()=>{
 const report=createReporter({env,fetcher,now:()=>Date.parse('2026-09-28T02:00:00Z')});
 for(const [period,start,end] of [['today','2026-09-27','2026-09-27'],['yesterday','2026-09-26','2026-09-26'],['7d','2026-09-21','2026-09-27']]){
  const r=await report(period);assert.equal(r.ok,true);assert.equal(r.range.since,start);assert.equal(r.range.until,end);
  assert.equal(r.totals.users,100);assert.equal(r.sign_up,50);assert.equal(r.stages[2].users,20);assert.equal(r.stages[0].count,null);
  assert.equal(r.traffic[0].source_medium,'google / cpc');assert.equal(r.attributed_events[0].count,10);assert.equal(r.warnings.length,3);
  const body=JSON.parse(calls.at(-1).opts.body);assert.equal(body.requests.length,4);assert.equal(body.requests[0].dateRanges[0].startDate,period==='7d'?'6daysAgo':period);
  assert.ok(!JSON.stringify(r).includes('private-token'));
 }
 assert.equal(calls.length,4);await Promise.all([report('today'),report('today')]);assert.equal(calls.length,4);
 assert.equal((await createReporter({env:{},fetcher})()).ok,false);
 for(const status of [401,403,429,500]){
  const r=await createReporter({env,fetcher:async()=>({ok:false,status,json:async()=>({secret:'NEVER_SHOW'})})})();assert.equal(r.ok,false);assert.ok(!r.error.includes('NEVER_SHOW'));
 }
 const unexpected=await createReporter({env,fetcher:async()=>{throw new Error('sensitive-provider-detail');}})();assert.ok(!unexpected.error.includes('sensitive-provider-detail'));
 const timeout=await createReporter({env,fetcher:async()=>{const e=new Error('timeout');e.name='TimeoutError';throw e;}})();assert.match(timeout.error,/timed out/);
 await assert.rejects(()=>report('bad'),/Invalid/);
 console.log('GA4 periods, totals, attribution, missing rows, warnings, caching and failures passed');
})().catch(e=>{console.error(e);process.exitCode=1});
