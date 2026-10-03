const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = path => fs.readFileSync(path, 'utf8');
const expected = {v9_landing:31096634,v9_email_verified:31096642,v9_checkout_started:31096650};
function browser(source) {
  const local = new Map(), session = new Map(), ga = [], meta = [], scripts = [];
  const ctx = {URL, URLSearchParams, window:{location:{search:'?'+new URLSearchParams({utm_source:source,utm_medium:source==='google'?'cpc':'paid-social',utm_campaign:'rook-test',utm_content:'creative-a',utm_term:'medical-sales',utm_id:'campaign-123'}),hostname:'rookcareers.com'}},document:{referrer:'',createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}},localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},sessionStorage:{getItem:k=>session.get(k),setItem:(k,v)=>session.set(k,v)},gtag:(...args)=>ga.push(args)};
  ctx.window.fbq=(...args)=>meta.push(args);ctx.fbq=ctx.window.fbq;
  vm.createContext(ctx);
  for (const path of ['public/rook-attribution.js','public/rook-linkedin.js','public/rook-v9-tracking.js']) vm.runInContext(read(path),ctx);
  return {ctx,ga,meta,scripts};
}
for (const source of ['linkedin','facebook','google']) {
  const b=browser(source);
  for (const name of Object.keys(expected)) {b.ctx.window.rookV9Track(name,{stage:'test',email:'private@example.test'});b.ctx.window.rookV9Track(name,{stage:'test'});}
  b.ctx.window.rookV9Track('v9_first_month_subscription_purchased',{status:'active'});
  b.ctx.window.rookV9Track('v9_checkout_success',{});
  b.ctx.window.rookLinkedInV9Track('paid_subscription_started');
  b.ctx.window.rookLinkedInV9Track('toString');
  const calls=JSON.parse(JSON.stringify(b.ctx.window.lintrk.q));
  assert.deepEqual(calls,Object.values(expected).map(conversion_id=>['track',{conversion_id}]));
  assert.equal(b.ga.length,5);
  for (const event of b.ga) {
    assert.equal(event[2].source,source);assert.equal(event[2].first_touch_source,source);
    assert.equal(event[2].first_touch_medium,source==='google'?'cpc':'paid-social');
    assert.equal(event[2].first_touch_campaign,'rook-test');assert.equal(event[2].first_touch_content,'creative-a');
    assert.equal(event[2].first_touch_term,'medical-sales');assert.equal(event[2].first_touch_id,'campaign-123');
    assert(!('email' in event[2]));
  }
  for (const event of ['ViewContent','InitiateCheckout','Subscribe']) assert(b.meta.some(c=>c[2]===event));
  vm.runInContext(read('public/rook-linkedin.js'),b.ctx);
  b.ctx.window.rookLinkedInV9Track('v9_landing');assert.equal(b.ctx.window.lintrk.q.length,3);
  assert.equal(b.scripts.filter(s=>s.src.includes('licdn.com')).length,1);
  b.ctx.window.lintrk=()=>{throw Error('blocked')};assert.doesNotThrow(()=>b.ctx.window.rookV9Track('v9_question_viewed',{stage:'test'}));
}
// Execute the actual shared checkout tracker with mocks: V9 only, no UI/payment actions.
const shared=read('public/rook-keep-access.html');
const track=shared.slice(shared.indexOf('    function track(name,stage){'),shared.indexOf('    let state,acquisitionProfile;'));
for (const source of ['v8','v9']) {
  const b=browser('linkedin');b.ctx.state={source,trialKey:'mock'};b.ctx.acquisitionProfile={utm_source:'linkedin',utm_id:'campaign-123'};
  vm.runInContext(track,b.ctx);
  b.ctx.track(source+'_checkout_started','payment');b.ctx.track(source+'_checkout_started','payment');
  b.ctx.track(source+'_first_month_subscription_purchased','active');
  assert.deepEqual(JSON.parse(JSON.stringify(b.ctx.window.lintrk.q)),source==='v9'?[['track',{conversion_id:31096650}]]:[]);
  assert.equal(b.ga[0][2].first_touch_id,'campaign-123');
}
console.log('PASS real LinkedIn conversion IDs; event allowlist/deduplication; no browser paid conversion or PII; all six UTMs; existing GA4/Meta/Google behavior; V9-only shared checkout. No live tracking requests.');
