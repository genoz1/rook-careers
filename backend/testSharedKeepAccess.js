const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {hasFullAccess}=require('./matching');
const {resolve}=require('../public/rook-keep-access');
const stripe=require('./routes/stripe');

const now=Date.now();
const activeEnd=new Date(now+3600000).toISOString(),expiredEnd=new Date(now-3600000).toISOString();
for(const source of ['v8','v9']){
  const active={subscription_status:'trialing',trial_source:source,trial_started_at:'2026-09-30T13:00:00Z',trial_ends_at:activeEnd};
  assert.equal(hasFullAccess(active),true,`${source} active trial must retain full access`);
  assert.deepEqual(resolve(active,now),{redirect:'rook-dashboard-v8.html'});
  const expired={...active,trial_ends_at:expiredEnd};
  const preserved=structuredClone(expired);
  assert.equal(hasFullAccess(expired),false,`${source} expired trial must lose member access`);
  const state=resolve(expired,now);
  assert.equal(state.source,source);assert.equal(state.endpoint,`/api/stripe/create-${source}-subscription-from-setup`);
  assert.equal(state.trialKey,active.trial_started_at);
  assert.deepEqual(expired,preserved,'routing must not mutate profile, preferences, matches, saves or résumé state');
  assert.deepEqual(resolve({...expired,subscription_status:'active'},now),{redirect:'rook-dashboard-v8.html'});
}

assert.deepEqual(resolve({subscription_status:'active'},now),{redirect:'rook-dashboard-v8.html'});
assert.match(resolve({subscription_status:'cancelled',trial_source:'v8',trial_started_at:'x',trial_ends_at:expiredEnd,subscription_started_at:'2026-09-01'},now).error,/already used/);
assert.equal(stripe.canPurchaseV8Intro({subscription_status:'cancelled',trial_source:'v8',trial_started_at:'x',subscription_started_at:null}),true);
assert.equal(stripe.canPurchaseV8Intro({subscription_status:'cancelled',trial_source:'v8',trial_started_at:'x',subscription_started_at:'used'}),false);
assert.equal(stripe.canPurchaseV9Intro({subscription_status:'cancelled',trial_source:'v9',trial_started_at:'x',subscription_started_at:null}),true);
assert.equal(stripe.canPurchaseV9Intro({subscription_status:'cancelled',trial_source:'v9',trial_started_at:'x',subscription_started_at:'used'}),false);

const publicDir=path.join(__dirname,'..','public');
const read=name=>fs.readFileSync(path.join(publicDir,name),'utf8');
const page=read('rook-keep-access.html');
for(const copy of ['KEEP YOUR ROOK ACCESS','Your free access has ended — but your ROOK account is still here.','Your matches, saved jobs, profile, and personalized job search are waiting for you.','$9.99','First 30 paid days','$19.99/month','Cancel anytime','KEEP MY ROOK ACCESS →','Secure checkout • Cancel anytime'])assert(page.includes(copy),`missing shared-screen copy: ${copy}`);
assert(!/start (?:free )?trial|3-day|72 hours|card required to start/i.test(page));
assert(page.includes('@media(max-width:420px)'));
for(const source of ['v8','v9'])for(const event of ['trial_expired','upgrade_paywall_viewed','checkout_started','first_month_subscription_purchased'])assert(page.includes(`state.source}_${event}`)||page.includes('`${state.source}_'+event+'`'),`missing attributed ${event}`);

for(const file of ['rook-v8-trial.js','rook-v9-trial.js','rook-auth-v8.js','rook-onboarding-v8-signup.html','rook-onboarding-v9-signup.html'])assert(read(file).includes('rook-keep-access.html'),`${file} does not route expired trials to the shared screen`);
assert(read('rook-v8-trial.js').includes("goToUpgrade(){window.location.replace('rook-checkout-v8.html')"));
assert(read('rook-v9-trial.js').includes("goToUpgrade(){window.location.replace('rook-checkout-v9.html')"));

const expected={
  'backend/v8Matching.js':'bbc570306d70a762559042a2a067cb656b442d42a471cce7ae40d9af9dd52b9a',
  'backend/v8MatchingIndex.js':'427487a4a029479b5ef7e8296e581856146ff2edd0216bebebe265cefc5219ea',
  'backend/v7Location.js':'f36809b47c22d074d14e218dc061a2645fb33bc0e731ec879bff88375c42ed31',
  'backend/v7Matching.js':'952fa46365edc721d7bca4c6aea21ef2e83634e96bc2664a2b4e383f91663c46',
  'backend/routes/jobs.js':'60e5d64a50deadbb7306041424ddf421096e5783ad059cd435464c4d699bf9cf',
};
for(const [file,hash] of Object.entries(expected)){const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',file))).digest('hex');assert.equal(actual,hash,`${file} changed`)}
console.log('PASS shared V8/V9 post-trial routing, copy, source-attributed checkout, one-use intro guard and protected matching hashes.');
