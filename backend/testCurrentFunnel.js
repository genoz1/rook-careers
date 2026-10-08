const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MEMBERSHIP_PLANS,accessEnd,handleStripeWebhookEvent}=require('./routes/stripe');
const {hasFullAccess}=require('./matching');
const {publicIp}=require('./ipLocation');
const {project}=require('./pretrialProjection');
const onboarding=require('./routes/onboardingV8')._test;

const root=path.join(__dirname,'..');
test('the acquisition surface has exactly the three paid offers and no trial offer',()=>{
  const html=fs.readFileSync(path.join(root,'public/rook-acquisition.html'),'utf8');
  const pricing=fs.readFileSync(path.join(root,'public/rook-pricing-current.html'),'utf8');
  const stripeSource=fs.readFileSync(path.join(root,'backend/routes/stripe.js'),'utf8');
  for(const text of [html,pricing]){
    assert.match(text,/2-Day Pass/);assert.match(text,/Monthly/);assert.match(text,/3-Month Pass/);
    assert.match(text,/\$5\.99/);assert.match(text,/\$9\.99/);assert.match(text,/\$39\.99/);
    assert.doesNotMatch(text,/free trial|no credit card required/i);
  }
  assert.deepEqual(Object.keys(MEMBERSHIP_PLANS),['two_day','monthly','three_month']);
  assert.match(stripeSource,/router\.post\('\/stripe\/create-checkout-session',retiredCheckout\)/);
  assert.match(stripeSource,/router\.post\('\/stripe\/create-subscription-from-setup',retiredCheckout\)/);
});

test('passes expire at their promised boundaries and monthly is the only recurring plan',()=>{
  const now=new Date('2026-01-31T12:00:00Z');
  assert.equal(accessEnd(MEMBERSHIP_PLANS.two_day,now),'2026-02-02T12:00:00.000Z');
  assert.equal(accessEnd(MEMBERSHIP_PLANS.three_month,now),'2026-04-30T12:00:00.000Z');
  assert.equal(MEMBERSHIP_PLANS.monthly.kind,'subscription');
  assert.equal(MEMBERSHIP_PLANS.two_day.kind,'one_time');
  assert.equal(MEMBERSHIP_PLANS.three_month.kind,'one_time');
  assert.equal(hasFullAccess({subscription_status:'active',subscription_cancel_at:'2099-01-01T00:00:00Z'}),true);
  assert.equal(hasFullAccess({subscription_status:'active',subscription_cancel_at:'2020-01-01T00:00:00Z'}),false);
});

test('a successful one-time payment grants the new purchaser an expiring entitlement exactly once',async()=>{
  const updates=[],conversions=[];
  const candidateBuilder=mode=>{
    const builder={
      eq(){return builder},is(){return builder},lt(){return builder},
      select(){return builder},
      maybeSingle(){return Promise.resolve({data:{name:'Buyer',email:'buyer@example.com',utm_source:'google'},error:null})},
      then(resolve,reject){return Promise.resolve({data:mode==='update'?[{id:'profile'}]:null,error:null}).then(resolve,reject)},
    };
    return builder;
  };
  const db={from(table){
    if(table==='candidate_profiles')return{
      update(payload){updates.push(payload);return candidateBuilder('update')},
      select(){return candidateBuilder('select')},
    };
    if(table==='ad_conversion_events')return{insert(payload){conversions.push(payload);return Promise.resolve({error:null})}};
    throw Error(`unexpected table ${table}`);
  }};
  const event={id:'evt_pass',type:'payment_intent.succeeded',created:Date.parse('2026-02-01T12:00:00Z')/1000,
    data:{object:{amount_received:599,currency:'usd',customer:'cus_pass',metadata:{membership_plan:'two_day',user_id:'user-pass'}}}};
  const first=await handleStripeWebhookEvent(event,{stripe:{},supabaseAdmin:db,subscriberNotifier:async()=>{},linkedinDelivery:async()=>{}});
  assert.equal(first.applied,true);
  assert.ok(updates.some(x=>x.subscription_status==='active'&&x.subscription_cancel_at==='2026-02-03T12:00:00.000Z'));
  assert.ok(updates.some(x=>x.subscription_started_at==='2026-02-01T12:00:00.000Z'));
  assert.equal(conversions[0].event_key,'first_paid_user-pass');
});

test('anonymous preview never reveals any source identity, title, URL, or ID',()=>{
  const raw={id:'real-id',company_name:'Secret Employer',title_original:'Unique Secret Title 9988',location_raw:'Exact City, FL',
    city:'Exact City',state:'FL',application_url:'https://secret.example/apply',source_url:'https://secret.example/source',category:'field sales',
    date_posted:'2026-10-01',match:{overall_score:81},ai_analysis:{product_categories:['Medical Device']}};
  const response=onboarding.previewResponse({home_location_label:'Nearby, FL',desired_industries:[]},[raw],false);
  const serialized=JSON.stringify(response);
  // City/state may appear as a safe location label; employer, exact title, IDs and URLs must not.
  for(const secret of ['real-id','Secret Employer','Unique Secret Title 9988','secret.example'])assert.equal(serialized.includes(secret),false);
  assert.equal(response.jobs[0].subscription_required,true);
  assert.match(response.jobs[0].id,/^locked-/);
  assert.equal(response.jobs[0].location_label,'Exact City, FL');
  const safe=project(raw,0,{dashboard:true});assert.equal(safe.company_name,undefined);
});

test('client IP parsing accepts public addresses and rejects private forwarding values',()=>{
  assert.equal(publicIp('::ffff:8.8.8.8'),'8.8.8.8');
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.2','172.16.0.1','::1','bad'])assert.equal(publicIp(ip),null);
});

test('current funnel tracks every required event through the deduplicating helper',()=>{
  const acquisition=fs.readFileSync(path.join(root,'public/rook-acquisition.js'),'utf8');
  const checkout=fs.readFileSync(path.join(root,'public/rook-checkout-current.html'),'utf8');
  const tracking=fs.readFileSync(path.join(root,'public/rook-v8-tracking.js'),'utf8');
  for(const event of ['acquisition_landing_viewed','protected_dashboard_viewed','ip_geolocation_success','ip_geolocation_failure','change_location_clicked','anonymous_job_interaction','pricing_paywall_viewed','membership_plan_selected','checkout_started','successful_paid_conversion'])
    assert.ok(acquisition.includes(event)||checkout.includes(event));
  assert.match(tracking,/currentEvents/);
});

test('acquisition cards keep generalized title, location, and industry readable',()=>{
  const css=fs.readFileSync(path.join(root,'public/rook-acquisition.css'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/rook-acquisition.js'),'utf8');
  assert.match(css,/\.job h2\{[^}]*color:#0a2f57/);
  assert.match(css,/\.meta\{[^}]*color:#4b6079/);
  assert.doesNotMatch(css,/\.job h2\{[^}]*filter:\s*blur/);
  assert.doesNotMatch(css,/\.meta\{[^}]*filter:\s*blur/);
  assert.doesNotMatch(css,/\.company\{[^}]*filter:\s*blur/);
  assert.match(js,/Employer hidden until unlock/);
  assert.match(js,/j\.role_type/);
  assert.match(js,/location_label/);
  assert.match(js,/industry_classification\?\.labels/);
  assert.doesNotMatch(js,/masked_lines\?\.employer/);
});

test('acquisition location updates show immediate progress instead of a silent wait',()=>{
  const js=fs.readFileSync(path.join(root,'public/rook-acquisition.js'),'utf8');
  const widget=fs.readFileSync(path.join(root,'public/rook-location-widget-v8.js'),'utf8');
  assert.match(js,/Updating opportunities near/);
  assert.match(js,/Finding your location/);
  assert.match(js,/setSubmitBusy/);
  assert.match(js,/skeletons\(\)/);
  assert.match(js,/resolveFromInput/);
  assert.match(js,/normalizeLocation/);
  assert.match(js,/previousJobs/);
  assert.match(js,/Use Change Location to try again/);
  assert.match(widget,/async function resolveFromInput/);
  assert.match(widget,/commit\(activeIdx >= 0 \? activeIdx : 0\)/);
});

test('locked preview responses stay small enough for a reliable location change',()=>{
  const source=fs.readFileSync(path.join(root,'backend/routes/onboardingV8.js'),'utf8');
  assert.match(source,/LOCKED_PREVIEW_LIMIT\s*=\s*48/);
  const {project}=require('./pretrialProjection');
  const raw=Array.from({length:80},(_,i)=>({
    id:'job-'+i,title_original:'Territory Manager',city:'Orlando',state:'FL',location_raw:'Orlando, FL',
    ai_analysis:{product_categories:['Medical Device']},match:{overall_score:90-i%10}
  }));
  // Mirror the locked previewResponse slice contract.
  const listed=raw.slice(0,48).map((j,i)=>project(j,i,{dashboard:true}));
  assert.equal(listed.length,48);
  assert.equal(listed[0].location_label,'Orlando, FL');
});
