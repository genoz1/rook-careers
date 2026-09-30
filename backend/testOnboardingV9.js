const assert=require('node:assert/strict');
const fs=require('node:fs');
const {INDUSTRIES,TERRITORIES,profileFrom,mergeFloor,prioritize,requiredYears}=require('./routes/onboardingV9')._test;
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

const jobs=Array.from({length:50},(_,i)=>({id:String(i),match:{overall_score:100-i},industry_classification:{version:1,labels:[i%2?'Diagnostics':'Veterinary']}}));
const floor=mergeFloor(jobs.slice(0,7),jobs,32);assert.equal(floor.jobs.length,32);assert.equal(floor.widened,true);assert.equal(floor.preferredCount,7);
assert.equal(new Set(floor.jobs.map(j=>j.id)).size,32);assert.equal(prioritize(jobs,['Diagnostics']).length,50);
const mixed=[{id:'general',match:{overall_score:99},industry_classification:{version:1,labels:['Medical Device']}},{id:'vet',match:{overall_score:70},industry_classification:{version:1,labels:['Veterinary']}}];
assert.equal(prioritize(mixed,['Veterinary'])[0].id,'vet');
assert.equal(requiredYears({experience_min_years:5}),5);assert.equal(requiredYears({ai_analysis:{required_years_experience:'3+ years'}}),3);

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
assert(browser.includes('rookRenderMaskedJob'));assert(browser.includes('Broader opportunity'));
assert(!browser.includes("await refine('location')"));assert(!browser.includes('setTimeout(()=>show(\'results\')'));
const routeSource=fs.readFileSync('backend/routes/onboardingV9.js','utf8');
assert(routeSource.includes('rankPool(pool,scoringProfile(profile),profile.desired_industries)'));
assert(routeSource.includes('prioritized_match_count'));
const maskedRenderer=fs.readFileSync('public/rook-pretrial.js','utf8');assert(maskedRenderer.includes('Membership unlocks the complete opportunity'));
const checkout=fs.readFileSync('public/rook-checkout-v9.html','utf8');
assert(checkout.includes('$9.99')&&checkout.includes('$19.99/month')&&checkout.includes('No free trial'));
assert(checkout.includes('create-v9-subscription-from-setup'));
const server=fs.readFileSync('server.js','utf8');assert(server.includes("app.get('/meta/v9'"));

console.log('PASS V9 isolated taxonomy, truthful profile, 32-result widening, no-trial coupon, copy, route and handoff.');
