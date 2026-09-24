const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/rook-onboarding-v7.html', 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) { const classes = new Set(); nodes.set(id, {value:'',style:{},textContent:'',disabled:true,listeners:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},addEventListener(event,fn){this.listeners[event]=fn;}}); }
  return nodes.get(id);
};
const screens = ['details','industry','years','territory','analyzing'].map(x=>node('s-'+x));
const industry = node('industry');industry.value='Diagnostics';
const years=node('years');years.value='5.5';
const territory=node('territory');territory.value='local';
const events=[],requests=[],store=new Map();let selected, fail=true;
const ctx={AbortSignal,document:{getElementById:node,querySelectorAll:s=>s==='.screen'?screens:s.includes('industry')?[industry]:s.includes('years')?[years]:s.includes('territory')?[territory]:[],querySelector:s=>s.includes('industry')?industry:s.includes('years')?years:null},window:{scrollTo(){},location:{href:''}},RookLocationWidget:{init:o=>selected=o},sessionStorage:{setItem:(k,v)=>store.set(k,v)},rookTrackFunnelEvent:n=>events.push(n),gtag(){},fetch:async(url,options)=>{requests.push({url,answers:JSON.parse(options.body)});return {ok:!fail,json:async()=>fail?{error:'Try again'}:{token:'safe-test-token'}};}};
vm.runInNewContext(source,ctx);
(async()=>{
 assert(node('s-details').classList.contains('active'));
 assert.equal(node('stepLabel').textContent,'Step 1 of 4');
 assert.equal(events.length,0,'arriving is not an onboarding start');
 node('locationInput').listeners.input();node('locationInput').listeners.input();
 assert.equal(events.filter(x=>x==='onboarding_started').length,1);
 const location={label:'Oxford, FL',lat:28.92,lng:-82.03,state:'FL',city:'Oxford',zip:'34484'};
 selected.onSelect(location);assert.equal(node('btnDetailsNext').disabled,false);
 node('btnDetailsNext').listeners.click();assert.equal(node('stepLabel').textContent,'Step 2 of 4');
 industry.listeners.change();node('btnIndustryNext').listeners.click();
 years.listeners.change();node('btnYearsNext').listeners.click();assert.equal(node('stepLabel').textContent,'Step 4 of 4');
 territory.listeners.change();await node('btnTerritoryNext').listeners.click();
 assert(events.includes('v7_questions_completed'),'completion is recorded even when match retrieval fails');
 assert.equal(node('matchesHeadline').textContent,'Unable to load your matches');
 assert.equal(node('btnAnalyzeBack').style.display,'flex');
 ctx.window.goBack();fail=false;await node('btnTerritoryNext').listeners.click();
 assert.equal(node('btnAnalyzeBack').style.display,'none');
 assert.equal(ctx.window.location.href,'rook-dashboard-v7.html');
 assert.deepEqual(requests.find(r=>r.url==='/api/v7/session').answers,{location,industry:'Diagnostics',years:5.5,territories:['local'],preparation:null,attribution:{}});
 assert.equal(store.get('rook_v7_token'),'safe-test-token');
 // Revisit every answer: submitted values must come from the current controls.
 ctx.window.goBack();ctx.window.goBack();ctx.window.goBack();ctx.window.goBack();
 const changed={label:'Boston, MA',lat:42.36,lng:-71.06,state:'MA',zip:'02108'};
 selected.onSelect(changed);node('btnDetailsNext').listeners.click();
 industry.value='Veterinary';node('btnIndustryNext').listeners.click();
 years.value='0';node('btnYearsNext').listeners.click();territory.value='remote';
 await node('btnTerritoryNext').listeners.click();
 const last=requests.filter(r=>r.url==='/api/v7/session').at(-1).answers;
 assert.deepEqual(last.location,changed);assert.equal(last.industry,'Veterinary');assert.equal(last.years,0);assert.deepEqual(last.territories,['remote']);

 assert(!html.includes('Over 100 people'));assert(!html.includes('id="s-welcome"'));
 // Execute production tracker: retries/double clicks do not duplicate transition events or forward private input.
 const tracked=[],meta=[],saved=new Map();const storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
 const analytics={sessionStorage:storage,localStorage:storage,gtag:(...a)=>tracked.push(a),fbq:(...a)=>meta.push(a)};analytics.window=analytics;
 vm.runInNewContext(fs.readFileSync('public/rook-tracking.js','utf8'),analytics);
 for(const event of ['onboarding_started','v7_questions_completed','v7_masked_dashboard_viewed','v7_unlock_clicked','v7_signup_started','v7_account_created','v7_checkout_started']) {
  analytics.rookTrackFunnelEvent(event,{source:'banner',email:'private@example.com'});analytics.rookTrackFunnelEvent(event,{source:'banner'});
  assert.equal(tracked.filter(x=>x[1]===event).length,1,event);
 }
 assert(!JSON.stringify([tracked,meta]).includes('private@example.com'));
 assert(!tracked.some(x=>/trial_activated/.test(x[1])));
 const heading={textContent:''};const render={document:{body:{dataset:{v7Conversion:'true'}},getElementById:()=>heading}};render.window=render;
 vm.runInNewContext(fs.readFileSync('public/rook-pretrial.js','utf8'),render);
 render.rookUpdateV7MatchCount(12);assert.equal(heading.textContent,'12 matching opportunities');render.rookUpdateV7MatchCount(0);assert.equal(heading.textContent,'No matches for these selections');
 const card=render.rookRenderMaskedJob({company_name:'SECRETEMPLOYER',title_original:'SECRETTITLE',source_url:'https://secret.invalid',role_type:'Territory Sales',industry_classification:{labels:['Diagnostics']},territory_type:'Local territory',freshness_label:'Current opportunity',match:{candidate_fit:null,preference_fit:84}});
 assert(!/SECRET|secret.invalid/.test(card));assert(card.includes('84%'));assert(card.includes('Preference Match'));assert(card.includes('Unlock my matches — 3 days free'));
 for (const file of ['public/rook-onboarding-v7-signup.html','public/rook-checkout-v7.html']) {const h=fs.readFileSync(file,'utf8');assert(h.includes('$19.99/month'));assert(h.includes('rook-privacy.html'));assert(h.includes('rook-terms.html'));}
 const dashboard=fs.readFileSync('public/rook-dashboard-v7.html','utf8');assert(dashboard.includes('if (!rookV7Unlocked) return;'));
 console.log('PASS conversion: immediate question one, no invented claims, four unchanged inputs, retry recovery, truthful completion events, deduplicated transitions, safe count/score/CTA rendering, offer disclosures and optional pretrial résumé.');
})().catch(e=>{console.error(e);process.exitCode=1;});
