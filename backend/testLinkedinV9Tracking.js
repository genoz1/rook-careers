const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {profileFrom}=require('./routes/onboardingV9')._test;
const read=p=>fs.readFileSync(p,'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function browser(search='',stored={},referrer='') {
 const local=new Map(Object.keys(stored).length?[['rook_attribution_v1',JSON.stringify(stored)]]:[]),session=new Map(),events=[],pixels=[],scripts=[];
 const ctx={URL,URLSearchParams,window:{location:{search,hostname:'rookcareers.com'}},document:{referrer,head:{appendChild:s=>scripts.push(s)},createElement:()=>({})},localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},sessionStorage:{getItem:k=>session.get(k),setItem:(k,v)=>session.set(k,v)},gtag:(...args)=>events.push(args)};
 ctx.window.fbq=(...args)=>pixels.push(args);
 vm.createContext(ctx);vm.runInContext(read('public/rook-attribution.js'),ctx);vm.runInContext(read('public/rook-v9-tracking.js'),ctx);
 return {ctx,events,pixels,scripts,stored:plain(ctx.rookGetStoredAttribution())};
}
const funnel=['v9_landing','v9_question_viewed','v9_question_answered','v9_value_viewed','v9_offer_view','v9_email_submitted','v9_email_verified','v9_free_trial_started','v9_upgrade_paywall_viewed','v9_checkout_started','v9_first_month_subscription_purchased'];
for(const source of ['linkedin','facebook','google']) {
 const utm={utm_source:source,utm_medium:source==='google'?'cpc':'paid-social',utm_campaign:'rook-test',utm_content:'creative-a',utm_term:'medical-sales',utm_id:'campaign-123'};
 const b=browser('?'+new URLSearchParams(utm));assert.deepEqual(b.stored,utm);
 const base={location:{lat:43.61,lng:-116.2,stateAbbr:'ID',zip:'83702'},industries:['Diagnostics'],years:4,territories:['local'],attribution:b.stored};
 const profile=profileFrom(base);for(const [k,v] of Object.entries(utm))assert.equal(profile[k],v);
 // Page handoffs remove query strings; stored first touch survives each page.
 for(const event of funnel){const page=browser('',b.stored);page.ctx.window.rookV9Track(event,{stage:'test'});assert.equal(page.events[0][2].source,source);for(const [k,v] of Object.entries(utm))assert.equal(page.events[0][2]['first_touch_'+k.slice(4)],v);}
 b.ctx.window.rookV9Track('v9_landing',{});b.ctx.window.rookV9Track('v9_landing',{});assert.equal(b.events.length,1);assert(b.pixels.some(x=>x[2]==='ViewContent'));
 execFileSync(process.execPath,['backend/testV9NoCardTrial.js'],{env:{...process.env,ROOK_TEST_ATTRIBUTION:JSON.stringify(utm)},stdio:'inherit'});
}
assert.equal(browser('?gclid=mock').stored.utm_source,'google');
assert.equal(browser('?gbraid=mock').stored.utm_medium,'cpc');
assert.equal(browser('?wbraid=mock').stored.utm_source,'google');
const returning=browser('?utm_source=linkedin',{utm_source:'facebook',utm_id:'original'});
assert.equal(returning.ctx.rookAttributionEventParams().source,'linkedin');assert.equal(returning.ctx.rookAttributionEventParams().first_touch_source,'facebook');assert.equal(returning.stored.utm_id,'original');
assert.equal(browser().ctx.rookAttributionEventParams().source,'direct');
assert.deepEqual(browser().stored,{});
assert.equal(browser('?',{},'https://www.linkedin.com/feed/').ctx.rookAttributionEventParams().source,'linkedin');
assert.equal(browser('?',{},'https://www.google.com/search?q=test').ctx.rookAttributionEventParams().source,'google');
assert.equal(browser('?',{},'https://example.com/article').ctx.rookAttributionEventParams().source,'referral');
const returningCheckout=browser('',{utm_source:'facebook'});assert.equal(returningCheckout.ctx.rookAttributionEventParams({utm_source:'linkedin',utm_id:'account-touch'}).first_touch_source,'linkedin');
const privateParams=browser('?utm_source=linkedin&utm_content=private@example.test').ctx.rookAttributionEventParams();assert(!('first_touch_content' in privateParams));
const tag=browser();vm.runInContext(read('public/rook-linkedin.js'),tag.ctx);vm.runInContext(read('public/rook-linkedin.js'),tag.ctx);assert.equal(tag.scripts.length,1);assert.deepEqual(plain(tag.ctx.window._linkedin_data_partner_ids),['9629410']);
for(const page of ['rook-onboarding-v9.html','rook-onboarding-v9-signup.html','rook-checkout-v9.html','rook-keep-access.html'])assert(read('public/'+page).includes('src="rook-linkedin.js"'));
for(const page of ['rook-dashboard-v8.html','rook-login-v8.html'])assert(read('public/'+page).includes('_linkedin_partner_id = "9629410"'));
assert(!read('public/rook-v9.js').includes('meta_paid_video'));
assert(read('public/rook-v9.js').includes("show('workflow')")); // successful session/matching completion, existing equivalent event
assert(read('public/rook-checkout-v9.html').includes('attribution:profile'));
assert(read('public/rook-keep-access.html').includes('rookAttributionEventParams(acquisitionProfile)'));
assert(read('public/rook-v9-trial.js').includes('rookAttributionEventParams(profile)'));
(async()=>{
 const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
 await db.exec('create table candidate_profiles(utm_source text);create table ad_conversion_events(utm_source text);insert into candidate_profiles values(\'facebook\');');
 const sql=read('backend/db/v9-attribution-utm-id.sql');await db.exec(sql);await db.exec(sql);
 assert.equal((await db.query('select utm_source,utm_id from candidate_profiles')).rows[0].utm_source,'facebook');
 await db.exec("insert into ad_conversion_events(utm_source,utm_id) values('linkedin','campaign-123')");assert.equal((await db.query('select utm_id from ad_conversion_events')).rows[0].utm_id,'campaign-123');await db.close();
 console.log('PASS LinkedIn/Meta/Google browser → V9 profile → verified claim/trial → checkout metadata → first-paid invoice ledger; first-touch, organic/direct/referral, tag deduplication, and idempotent SQL migration.');
})().catch(e=>{console.error(e);process.exitCode=1});
