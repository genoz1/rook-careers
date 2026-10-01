const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

process.env.SUPABASE_URL='https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='server';

const rawToken='b'.repeat(64),tokenHash=crypto.createHash('sha256').update(rawToken).digest('hex');
const tables={
  onboarding_v7_sessions:[{token_hash:tokenHash,user_id:null,transferred_at:null,expires_at:'2099-01-01T00:00:00Z',profile:{onboarding_version:'v8',home_zip:'10001',desired_industries:['Diagnostics'],utm_source:'google'}}],
  candidate_profiles:[],ad_conversion_events:[],
};
const accountPushes=[];
class Query{
  constructor(name){this.name=name;this.filters=[];this.mode=null;this.value=null;this.single=false;}
  select(){return this;}eq(k,v){this.filters.push(row=>row[k]===v);return this;}gt(k,v){this.filters.push(row=>row[k]>v);return this;}
  is(k,v){this.filters.push(row=>(row[k]??null)===v);return this;}maybeSingle(){this.single=true;return this;}
  update(value){this.mode='update';this.value=value;return this;}upsert(value){this.mode='upsert';this.value=value;return this;}
  insert(value){this.mode='insert';this.value=value;return this;}
  then(resolve){const rows=tables[this.name].filter(row=>this.filters.every(fn=>fn(row)));
    if(this.mode==='update')rows.forEach(row=>Object.assign(row,this.value));
    if(this.mode==='upsert'){const existing=tables[this.name].find(row=>row.user_id===this.value.user_id);existing?Object.assign(existing,this.value):tables[this.name].push({...this.value});}
    if(this.mode==='insert')tables[this.name].push({...this.value});
    return Promise.resolve({data:this.single?rows[0]||null:rows,error:null}).then(resolve);
  }
}
const db={
  from:name=>new Query(name),
  auth:{getUser:async token=>({data:{user:token==='valid'?{id:'user-1',email:'verified@example.test',email_confirmed_at:'yes'}:null}})},
  rpc:async(name,args)=>{
    assert.equal(name,'activate_v8_trial');assert.equal(args.p_user_id,'user-1');
    const p=tables.candidate_profiles[0],now=new Date(),active=p.trial_ends_at&&new Date(p.trial_ends_at)>now;
    let outcome;
    if(p.subscription_status==='active')outcome='paid';
    else if(p.subscription_status==='trialing'&&active)outcome=p.trial_source==='v8'?'trial_active':'existing_access';
    else if(p.subscription_started_at)outcome='paid_lapsed';
    else if(p.trial_started_at||p.stripe_customer_id)outcome='trial_used';
    else{outcome='started';p.subscription_status='trialing';p.trial_started_at=now.toISOString();p.trial_ends_at=new Date(now.getTime()+86400000).toISOString();p.trial_source='v8';}
    return {data:[{outcome,subscription_status:p.subscription_status,trial_started_at:p.trial_started_at,trial_ends_at:p.trial_ends_at,trial_source:p.trial_source}],error:null};
  },
};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./v8Matching')]={exports:{rank:async()=>[],indexFor:()=>({refresh:async()=>{}}),startIndex:()=>{}}};
require.cache[require.resolve('./adminPush')]={exports:{notifyNewAccount:async payload=>{accountPushes.push(payload);throw Error('simulated Pushover outage');},notifyNewSubscriber:async()=>({sent:false})}};

const router=require('./routes/onboardingV8');
const claimHandler=router.stack.find(layer=>layer.route?.path==='/claim').route.stack[0].handle;
const stripeRoute=require('./routes/stripe');

(async()=>{
  const claim=async(valid=true)=>{let status=200,data;const req={body:{},get:name=>name==='X-ROOK-V7'?rawToken:name==='Authorization'?valid?'Bearer valid':'Bearer unverified':''};const res={status(code){status=code;return this},json(value){data=value;return this}};await claimHandler(req,res);return {status,data};};
  assert.equal((await claim(false)).status,401);assert.equal(accountPushes.length,0);
  const originalWarn=console.warn;console.warn=()=>{};
  const first=await claim();
  console.warn=originalWarn;
  assert.equal(first.status,200);assert.equal(first.data.outcome,'started');assert.equal(first.data.trial_source,'v8');
  assert.equal(new Date(first.data.trial_ends_at)-new Date(first.data.trial_started_at),86400000);
  assert.equal(tables.ad_conversion_events.length,1);assert.equal(tables.ad_conversion_events[0].event_key,'v8_trial_started_user-1');
  assert.equal(accountPushes.length,1);assert.equal(accountPushes[0].version,'V8');assert.equal(accountPushes[0].profile.utm_source,'google');
  const startedAt=first.data.trial_started_at;
  const repeat=await claim();assert.equal(repeat.data.outcome,'trial_active');assert.equal(repeat.data.trial_started_at,startedAt);assert.equal(tables.ad_conversion_events.length,1);assert.equal(accountPushes.length,1);

  Object.assign(tables.candidate_profiles[0],{subscription_status:'trialing',trial_source:'v9',trial_started_at:'2026-01-01T00:00:00Z',trial_ends_at:'2099-01-01T00:00:00Z'});
  assert.equal((await claim()).data.outcome,'existing_access');
  tables.candidate_profiles[0].trial_ends_at='2026-01-02T00:00:00Z';
  assert.equal((await claim()).data.outcome,'trial_used');
  Object.assign(tables.candidate_profiles[0],{subscription_status:'active',subscription_started_at:'2026-01-03T00:00:00Z'});
  assert.equal((await claim()).data.outcome,'paid');

  const v8Profile={trial_source:'v8',trial_started_at:'2026-01-01T00:00:00Z',subscription_started_at:null,subscription_status:'cancelled'};
  assert.equal(stripeRoute.canPurchaseV8Intro(v8Profile),true);
  assert.equal(stripeRoute.canPurchaseV8Intro({...v8Profile,trial_source:'v9'}),false);
  assert.equal(stripeRoute.canPurchaseV8Intro({...v8Profile,subscription_started_at:'2026-01-02T00:00:00Z'}),false);
  const params=stripeRoute.buildV8SubscriptionParams({customerId:'cus_test',paymentMethodId:'pm_test',userId:'user-1',priceId:'price_1999',couponId:'coupon_10'});
  assert.deepEqual(params.items,[{price:'price_1999'}]);assert.deepEqual(params.discounts,[{coupon:'coupon_10'}]);
  assert.equal(params.metadata.onboarding_version,'v8');assert.equal(params.trial_period_days,undefined);

  const v9Sql=fs.readFileSync(path.join(__dirname,'db','v9-no-card-trial.sql'),'utf8');
  assert.match(v9Sql,/p\.trial_started_at is not null\s+or p\.stripe_customer_id is not null/);
  assert.match(v9Sql,/p\.trial_source = 'v9' then 'trial_active' else 'existing_access'/);

  const publicDir=path.join(__dirname,'..','public');
  const signup=fs.readFileSync(path.join(publicDir,'rook-onboarding-v8-signup.html'),'utf8');
  const checkout=fs.readFileSync(path.join(publicDir,'rook-checkout-v8.html'),'utf8');
  assert(signup.includes('24 hours of full access. No credit card required.'));
  assert(signup.includes('Verify and start my 24 hours'));
  assert(checkout.includes('/api/stripe/create-v8-subscription-from-setup'));
  assert(checkout.includes('$9.99 for your first 30 days, then $19.99/month. Cancel anytime.'));
  for(const event of ['v8_checkout_started','v8_upgrade_paywall_viewed','v8_first_month_subscription_purchased'])assert(checkout.includes(event));
  const trialUi=fs.readFileSync(path.join(publicDir,'rook-v8-trial.js'),'utf8');
  for(const event of ['v8_dashboard_accessed','v8_trial_expired','v8_subscription_state'])assert(trialUi.includes(event));
  assert(!/3-day|3 days/i.test(signup+checkout));
  console.log('PASS V8 verified-email no-card trial, account-wide repeat prevention, introductory billing parameters and required copy.');
})().catch(error=>{console.error(error);process.exitCode=1});
