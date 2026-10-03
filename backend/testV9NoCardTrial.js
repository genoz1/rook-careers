const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const acquisition=JSON.parse(process.env.ROOK_TEST_ATTRIBUTION||'{"utm_source":"facebook"}');

process.env.SUPABASE_URL='https://test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY='server';

const rawToken='a'.repeat(64),tokenHash=crypto.createHash('sha256').update(rawToken).digest('hex');
const tables={
  onboarding_v7_sessions:[{token_hash:tokenHash,user_id:null,transferred_at:null,expires_at:'2099-01-01T00:00:00Z',profile:{onboarding_version:'v9',home_zip:'10001',...acquisition,v9_opportunity_count:40,v9_best_match_count:32}}],
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
  auth:{getUser:async token=>({data:{user:token==='valid'?{id:'user-1',email:'verified@example.test',email_confirmed_at:'yes',user_metadata:{first_name:'Test',last_name:'User'}}:null}})},
  rpc:async(name,args)=>{
    assert.equal(name,'activate_v9_trial');assert.equal(args.p_user_id,'user-1');
    const p=tables.candidate_profiles[0],now=new Date(),active=p.trial_ends_at&&new Date(p.trial_ends_at)>now;
    let outcome;
    if(p.subscription_status==='active')outcome='paid';
    else if(p.subscription_status==='trialing'&&active)outcome=p.trial_source==='v9'?'trial_active':'existing_access';
    else if(p.subscription_started_at)outcome='paid_lapsed';
    else if(p.trial_started_at||p.stripe_customer_id)outcome='trial_used';
    else{outcome='started';p.subscription_status='trialing';p.trial_started_at=now.toISOString();p.trial_ends_at=new Date(now.getTime()+86400000).toISOString();p.trial_source='v9';p.digest_enabled=args.p_marketing_consent;p.marketing_consent_at=args.p_marketing_consent?now.toISOString():null;}
    return {data:[{outcome,subscription_status:p.subscription_status,trial_started_at:p.trial_started_at,trial_ends_at:p.trial_ends_at,trial_source:p.trial_source}],error:null};
  },
};
require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
require.cache[require.resolve('./v8Matching')]={exports:{readCandidates:async()=>[],indexFor:()=>({current:async()=>[]}),startIndex:()=>{}}};
require.cache[require.resolve('./v7Matching')]={exports:{rankPool:()=>[]}};
require.cache[require.resolve('./v7Location')]={exports:{prepareJob:job=>job}};
require.cache[require.resolve('./adminPush')]={exports:{notifyNewAccount:async payload=>{accountPushes.push(payload);return {sent:true};},notifyNewSubscriber:async()=>({sent:true})}};

const router=require('./routes/onboardingV9');
const claimHandler=router.stack.find(layer=>layer.route?.path==='/claim').route.stack[0].handle;
(async()=>{
  const claim=async(consent,valid=true)=>{let status=200,data;const req={body:{marketing_consent:consent},get:name=>name==='X-ROOK-V9'?rawToken:name==='Authorization'?valid?'Bearer valid':'Bearer unverified':''};const res={status(code){status=code;return this},json(value){data=value;return this}};await claimHandler(req,res);return {status,data};};
  try{
    assert.equal((await claim(false,false)).status,401);assert.equal(accountPushes.length,0);
    const first=await claim(true);assert.equal(first.status,200);assert.equal(first.data.outcome,'started');
    assert.equal(tables.candidate_profiles[0].email,'verified@example.test');assert.equal(tables.candidate_profiles[0].trial_source,'v9');
    assert.equal(new Date(first.data.trial_ends_at)-new Date(first.data.trial_started_at),86400000);
    assert.equal(tables.candidate_profiles[0].digest_enabled,true);assert(tables.candidate_profiles[0].marketing_consent_at);
    assert.equal(tables.ad_conversion_events.length,1);assert.equal(tables.ad_conversion_events[0].event_type,'trial_started');
    assert.equal(accountPushes.length,1);assert.equal(accountPushes[0].version,'V9');assert.equal(accountPushes[0].profile.utm_source,acquisition.utm_source);
    for(const [key,value] of Object.entries(acquisition)){assert.equal(tables.candidate_profiles[0][key],value);assert.equal(tables.ad_conversion_events[0][key],value);}
    const startedAt=first.data.trial_started_at,second=await claim(false);assert.equal(second.data.outcome,'trial_active');assert.equal(second.data.trial_started_at,startedAt);assert.equal(tables.ad_conversion_events.length,1);assert.equal(accountPushes.length,1);
    tables.candidate_profiles[0].trial_ends_at='2020-01-01T00:00:00Z';
    const expired=await claim(false);assert.equal(expired.data.outcome,'trial_used');assert.equal(expired.data.trial_started_at,startedAt);
    const stripe=require('./routes/stripe');
    const params=stripe.buildV9SubscriptionParams({customerId:'cus_mock',paymentMethodId:'pm_mock',userId:'user-1',priceId:'price_mock',couponId:'coupon_mock',utm:acquisition});
    for(const [key,value] of Object.entries(acquisition))assert.equal(params.metadata[key],value);
    const paidRows=new Map();
    const paidDb={from:table=>table==='candidate_profiles'?{select:()=>({eq:()=>({maybeSingle:async()=>({data:tables.candidate_profiles[0]})})})}:{insert:async row=>{if(paidRows.has(row.event_key))return {error:{code:'23505'}};paidRows.set(row.event_key,row);return {};}}};
    const invoice=(type,amount,status='paid')=>({created:100,type,data:{object:{customer:'cus_mock',subscription:'sub_mock',status,amount_paid:amount}}});
    const options={supabaseAdmin:paidDb,subscriberNotifier:async()=>{}};
    assert.equal((await stripe.handleStripeWebhookEvent(invoice('invoice.paid',0),options)).applied,false);
    assert.equal((await stripe.handleStripeWebhookEvent(invoice('invoice.paid',999,'open'),options)).applied,false);
    assert.equal((await stripe.handleStripeWebhookEvent(invoice('invoice.paid',999),options)).applied,true);
    assert.equal((await stripe.handleStripeWebhookEvent(invoice('invoice.payment_succeeded',999),options)).applied,false);
    assert.equal((await stripe.handleStripeWebhookEvent(invoice('invoice.paid',1999),options)).applied,false);
    assert.equal(paidRows.size,1);
    for(const [key,value] of Object.entries(acquisition))assert.equal([...paidRows.values()][0][key],value);
    assert.equal([...paidRows.values()][0].event_type,'paid_subscription_started');
    // A later campaign/session must not overwrite an existing account's touch.
    tables.onboarding_v7_sessions[0].transferred_at=null;
    tables.onboarding_v7_sessions[0].profile={...tables.onboarding_v7_sessions[0].profile,utm_source:'later-channel',utm_id:'later-id'};
    await claim(false);
    for(const [key,value] of Object.entries(acquisition))assert.equal(tables.candidate_profiles[0][key],value);

    console.log('PASS V9 verified-email activation starts one 24-hour no-card trial and never resets it.');
  }finally{}
})().catch(error=>{console.error(error);process.exitCode=1});
