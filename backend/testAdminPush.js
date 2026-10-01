const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {sendAdminPush,notifyNewAccount,notifyNewSubscriber}=require('./adminPush');

test('missing configuration disables pushes without a request',async()=>{
  let called=false;
  const result=await sendAdminPush({title:'test',message:'test'},{env:{},fetchImpl:async()=>{called=true}});
  assert.deepEqual(result,{sent:false,reason:'disabled'});assert.equal(called,false);
});

test('account push contains only operational attribution and uses server credentials',async()=>{
  let request;
  const result=await notifyNewAccount({version:'V8',profile:{utm_source:'google',utm_medium:'cpc',utm_campaign:'fall-search'},occurredAt:'2026-10-01T16:42:00Z'},
    {env:{PUSHOVER_APP_TOKEN:'app-test',PUSHOVER_USER_KEY:'user-test'},fetchImpl:async(url,options)=>{request={url,options};return {ok:true,status:200}}});
  assert.equal(result.sent,true);assert.equal(request.url,'https://api.pushover.net/1/messages.json');
  const body=Object.fromEntries(request.options.body);
  assert.equal(body.token,'app-test');assert.equal(body.user,'user-test');assert.match(body.title,/New ROOK Account/);
  assert.match(body.message,/24-hour access activated/);assert.match(body.message,/V8 • Google Ads/);assert.match(body.message,/Campaign: fall-search/);
  assert.doesNotMatch(body.message,/email|password|resume|token/i);
});

test('subscriber push reports the actual paid amount and attribution',async()=>{
  let body;
  await notifyNewSubscriber({version:'V9',profile:{utm_source:'facebook',utm_medium:'paid_social',utm_campaign:'launch'},amountPaid:999,currency:'usd',occurredAt:'2026-10-01T16:42:00Z'},
    {env:{PUSHOVER_APP_TOKEN:'app-test',PUSHOVER_USER_KEY:'user-test'},fetchImpl:async(_url,options)=>{body=Object.fromEntries(options.body);return {ok:true,status:200}}});
  assert.match(body.message,/\$9\.99 subscription payment confirmed/);assert.match(body.message,/V9 • Meta Ads/);
});

test('network and API failures are contained and logs never expose credentials',async()=>{
  const logs=[];const options={env:{PUSHOVER_APP_TOKEN:'secret-app',PUSHOVER_USER_KEY:'secret-user'},logger:{warn:value=>logs.push(value)}};
  const network=await sendAdminPush({title:'test',message:'test'},{...options,fetchImpl:async()=>{throw Error('offline')}});
  const rejected=await sendAdminPush({title:'test',message:'test'},{...options,fetchImpl:async()=>({ok:false,status:401})});
  assert.equal(network.sent,false);assert.equal(rejected.sent,false);
  assert.doesNotMatch(logs.join(' '),/secret-app|secret-user/);
});

test('Pushover credentials and integration remain server-side only',()=>{
  const publicFiles=fs.readdirSync('public').filter(name=>/\.(?:js|html)$/.test(name));
  for(const file of publicFiles){const source=fs.readFileSync(`public/${file}`,'utf8');assert.doesNotMatch(source,/PUSHOVER_(?:APP_TOKEN|USER_KEY)/,file);}
});
