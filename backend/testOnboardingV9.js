const assert=require('node:assert/strict');
const fs=require('node:fs');
const {INDUSTRIES,TERRITORIES,profileFrom,availabilityProfile,territoryPreference,storedSummary}=require('./routes/onboardingV9')._test;
const stripe=require('./routes/stripe');

assert.deepEqual(INDUSTRIES,['Diagnostics','Medical Device','Pharmaceutical','Veterinary','Biotech/Life Sciences','Healthcare SaaS','Dental','Distribution','Capital Equipment']);
assert.deepEqual(TERRITORIES,['local','regional','national','remote']);
const base={location:{lat:43.61,lng:-116.2,city:'Boise',stateAbbr:'ID',zip:'83702',label:'Boise, ID'},
  industries:['Diagnostics','Veterinary'],years:4,territories:['local'],attribution:{utm_source:'facebook',utm_medium:'paid_social'}};
const profile=profileFrom(base);
assert.deepEqual(profile.desired_industries,['Diagnostics','Veterinary']);
assert.equal(profile.total_sales_years,4);assert.deepEqual(profile.territory_size_preferences,['local']);
assert.equal(profile.onboarding_version,'v9');assert.equal(profile.utm_source,'facebook');
assert(!Object.hasOwn(profile,'salary'));assert(!Object.hasOwn(profile,'work_authorization'));
assert.throws(()=>profileFrom({...base,industries:['Medical Sales']}));
assert.throws(()=>profileFrom({...base,territories:[]}));

assert.deepEqual(availabilityProfile(profile).territory_size_preferences,TERRITORIES);
assert.equal(territoryPreference({geographic_eligibility:{kind:'local',distance_miles:30}},profile),1);
assert.equal(territoryPreference({geographic_eligibility:{kind:'local',distance_miles:120}},profile),0);
assert.equal(territoryPreference({geographic_eligibility:{kind:'remote_us'}},{territory_size_preferences:['remote']}),1);
const persisted=storedSummary({...profile,v9_opportunity_count:327,v9_best_match_count:32});
assert.equal(persisted.opportunity_count,327);assert.equal(persisted.best_match_count,32);
assert.equal(storedSummary(profile),null);

assert(stripe.validateV9Coupon({valid:true,duration:'once',amount_off:1000,currency:'usd'}));
for(const bad of [
  {valid:false,duration:'once',amount_off:1000,currency:'usd'},
  {valid:true,duration:'forever',amount_off:1000,currency:'usd'},
  {valid:true,duration:'once',amount_off:900,currency:'usd'},
  {valid:true,duration:'once',amount_off:1000,currency:'cad'},
])assert.throws(()=>stripe.validateV9Coupon(bad));
assert(stripe.validateV9MonthlyPrice({active:true,currency:'usd',unit_amount:1999,type:'recurring',recurring:{interval:'month',interval_count:1}}));
assert.throws(()=>stripe.validateV9MonthlyPrice({active:true,currency:'usd',unit_amount:999,type:'recurring',recurring:{interval:'month',interval_count:1}}));
const params=stripe.buildV9SubscriptionParams({customerId:'cus_1',paymentMethodId:'pm_1',userId:'u1',priceId:'price_1',couponId:'coupon_1',utm:{utm_source:'facebook'}});
assert.deepEqual(params.discounts,[{coupon:'coupon_1'}]);assert(!Object.hasOwn(params,'trial_period_days'));
assert.equal(params.payment_behavior,'error_if_incomplete');assert.equal(params.metadata.onboarding_version,'v9');

const html=fs.readFileSync('public/rook-onboarding-v9.html','utf8');
const browser=html+fs.readFileSync('public/rook-v9.js','utf8');
for(const label of INDUSTRIES)assert(browser.includes(label));
assert(html.includes('Built from 10+ years of helping people connect with the right job opportunities.'));
assert(html.includes('Finding the opportunity is just the beginning.'));
for(const feature of ['Job Analysis','Tailor Resume','Cover Letter','LinkedIn Contact Search','Recruiter Message','Search Jobs by Company','Interview Prep','Save &amp; Track Applications'])assert(html.includes(feature));
assert(!/salary|authorized to work/i.test(html));
assert(html.includes('Now let’s find your'));assert(html.includes('opportunities that best match your interests and experience'));
assert(html.includes('EXAMPLE DISPLAY ONLY'));assert(html.includes('These are not current job listings.'));
assert(html.includes('data-screen="matching-intro"'));assert(html.includes('data-screen="samples"'));assert(html.includes('id="sampleJobs"'));
assert(html.includes('rook-v9.css?v=4'));assert(html.includes('rook-v9.js?v=4'));
for(const title of ['Diagnostic Territory Manager','Veterinary Territory Manager','Animal Health Specialty Representative','Dental Technology Sales Representative','Strategic Equipment Sales Representative'])assert(browser.includes(title));
assert(browser.includes('SAMPLE ${score}% MATCH'));assert(browser.includes('Example location near'));
assert(browser.includes('function ensureFlowDom()'));assert(browser.includes("document.getElementById('sampleJobs')"));
assert(!browser.includes('rookRenderMaskedJob'));assert(!html.includes('data-screen="results"'));assert(!html.includes('rook-pretrial.js'));
assert(!browser.includes("refine('industry')"));assert(!browser.includes("refine('experience')"));assert(!browser.includes('setTimeout('));
const routeSource=fs.readFileSync('backend/routes/onboardingV9.js','utf8');
assert(routeSource.includes("stage!=='location'"));assert(routeSource.includes('distance_miles)>250'));
assert(routeSource.includes('rankPool(opportunities,rankingProfile,[])'));
assert(!routeSource.includes('prioritized_match_count'));
const checkout=fs.readFileSync('public/rook-checkout-v9.html','utf8');
assert(checkout.includes('$9.99')&&checkout.includes('$19.99/month')&&checkout.includes('No free trial'));
assert(checkout.includes('create-v9-subscription-from-setup'));
const signup=fs.readFileSync('public/rook-onboarding-v9-signup.html','utf8');
for(const page of [signup,checkout]){assert(page.includes('opportunities available from your area'));assert(page.includes('p.opportunity_count.toLocaleString()'));assert(!page.includes('p.best_match_count.toLocaleString()'));}
assert(routeSource.includes('v9_opportunity_count:calculated.opportunities.length'));
assert(routeSource.includes('v9_best_match_count:calculated.jobs.length'));
assert(routeSource.includes('delete profile.v9_opportunity_count'));assert(routeSource.includes('delete profile.v9_best_match_count'));
const server=fs.readFileSync('server.js','utf8');assert(server.includes("app.get('/meta/v9'"));

console.log('PASS V9 isolated taxonomy, stable geographic pool, illustrative samples, no-trial coupon, copy, route and handoff.');
