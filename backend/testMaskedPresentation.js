const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {maskedTitle,generalizedRole,safeSpecialty,freshness} = require('./maskedPresentation');
const {preview} = require('./v7Preview');
const {redactForNonSubscriber} = require('./redaction');
const cases = [
 ['Specialty Account Manager, Symbravo (Des Moines, IA)','Axsome Therapeutics','Specialty Account Manager (Des Moines, IA)'],
 ['Executive Oncology Sales Representative – Head & Neck (Denver-Omaha) – Johnson & Johnson Innovative Medicine','Johnson & Johnson','Executive Oncology Sales Representative – Head & Neck (Denver-Omaha)','Denver, Colorado | Omaha, Nebraska'],
 ['Immunology Sales Specialist, Dermatology (Boise, ID)– Johnson & Johnson Innovative Medicine','Johnson & Johnson','Immunology Sales Specialist, Dermatology (Boise, ID)'],
 ['Area Sales Director, Molecular Diagnostics, QIAstat (East Region)','QIAGEN','Area Sales Director, Molecular Diagnostics (East Region)'],
 ['Territory Manager, CardioMEMS - Western Region','Abbott','Territory Manager - Western Region'],
 ['Veterinary Regional Sales Manager - Charlotte/Raleigh, NC (Royal Canin)','Royal Canin','Veterinary Regional Sales Manager - Charlotte/Raleigh, NC'],
 ['Specialty Account Manager, Unseenbrand (Des Moines, IA)','New Employer','Specialty Account Manager (Des Moines, IA)'],
 ['Oncology Sales Representative','Oncology Brands Inc.','Oncology Sales Representative'],
 ["Women's Health Account Executive",'Example',"Women's Health Account Executive"],
 ['Clinical Account Executive - Portland, OR','Example','Clinical Account Executive - Portland, OR'],
 ['Regional Manager - MWI','MWI Animal Health','Regional Manager'],
];
for (const [title,company,expected,location] of cases) {
 const job={title_original:title,company_name:company,location_raw:location};const original=JSON.stringify(job);
 assert.equal(maskedTitle(job),expected,title);
 assert.equal(preview(job,0).title_original,undefined);
 assert.equal(redactForNonSubscriber(job).title_original,undefined);
 assert.equal(JSON.stringify(job),original,'source job must remain unchanged');
}
const generalizedCases = [
 ['Specialty Account Manager, Symbravo (Des Moines, IA)','Specialty Account Manager'],
 ['Executive Oncology Sales Representative – Head & Neck (Denver-Omaha) – Johnson & Johnson Innovative Medicine','Executive Oncology Sales Representative'],
 ['Immunology Sales Specialist, Dermatology (Boise, ID) – Johnson & Johnson Innovative Medicine','Immunology Sales Specialist'],
 ['Area Sales Director, Molecular Diagnostics, QIAstat (East Region)','Area Sales Director'],
 ['Territory Manager, CardioMEMS – Western Region','Territory Manager'],
 ['Veterinary Regional Sales Manager – Charlotte/Raleigh, NC (Royal Canin)','Veterinary Regional Sales Manager'],
 ['Oncology Sales Representative','Oncology Sales Representative'],
 ['Clinical Account Executive – Portland, OR','Clinical Account Executive'],
 ['Account Executive II – North Orlando – [Hidden Health]','Account Executive II'],
 ['Veterinary District Sales Manager – Florida West – [Royal Canin]','Veterinary District Sales Manager'],
 ['Clinical Sales Specialist, Surgical Pain – Cleveland, OH','Clinical Sales Specialist'],
 ['Territory Manager – BrandX Pump – Orlando','Territory Manager'],
 ['Oncology Account Executive – [Hidden Pharma] – Central Florida','Oncology Account Executive'],
 ['Area Sales Director, Molecular Diagnostics, QIAstat (East Region)','Area Sales Director'],
 ['Acme Oncology Corp – Account Executive – Tampa','Account Executive'],
 ['Req 882401 | Territory Manager – Orlando','Territory Manager'],
 ['BrandZ HyperPulse Advisor – Eastern Florida','Medical Device Sales Role'],
];
for(const [title,expected] of generalizedCases) {
 const result=generalizedRole({title_original:title,ai_analysis:{product_categories:['Medical Device']}});
 assert.equal(result,expected,title);
 assert(!/Hidden Health|Royal Canin|Cleveland|Orlando|Tampa|Florida|QIAstat|BrandX|BrandZ|882401|Acme|Pulse|East Region/i.test(result),title);
}
assert.equal(safeSpecialty({ai_analysis:{product_categories:['Surgical','BrandX Pump']}}),'Surgical');
assert.equal(safeSpecialty({ai_analysis:{product_categories:['BrandX Pump']}}),null);
assert.equal(freshness({date_posted:'2026-09-19'},Date.parse('2026-09-19T16:00:00Z'),true),'Posted today');
assert.equal(freshness({date_posted:'2026-09-18'},Date.parse('2026-09-19T16:00:00Z'),true),'Posted yesterday');
assert.equal(freshness({date_posted:'2026-09-16'},Date.parse('2026-09-19T16:00:00Z'),true),'Posted 3 days ago');
assert.equal(freshness({date_posted:null,first_seen_at:'2026-09-18'},Date.parse('2026-09-19T16:00:00Z'),true),'Added yesterday');
assert.equal(freshness({date_posted:null},Date.parse('2026-09-19'),true),null);
assert.equal(freshness({date_posted:'2026-09-16'},Date.parse('2026-09-19')),'Recently posted');
function renderer(file) {
 const html=fs.readFileSync(require('node:path').join(__dirname,'../public',file),'utf8');
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if(m[1].trim()) new vm.Script(m[1]);
 const start=html.indexOf('  function renderRealJobRow(job) {');
 const end=html.indexOf('\n  async function',start);
 const next=html.indexOf('\n  function ',start+15);
 const source=html.slice(start,Math.min(...[end,next].filter(x=>x>start)));
 const context={Number,Date,Math,document:{body:{dataset:{v7Conversion:file==='rook-dashboard-v7.html'?'true':'false'}}},escapeHtml:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),isRemoteJob:()=>false,isNewJob:()=>false,renderCategoryRows:()=>'<div>Full category scoring</div>',lockedJobCtaLabel:'Unlock this job'};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../public/rook-pretrial.js'),'utf8'),context);vm.runInContext(source,context);return {render:context.renderRealJobRow,html};
}
for(const file of ['rook-dashboard.html','rook-dashboard-v7.html']) {
 const {render}=renderer(file);
 const base={id:'test',role_type:'Oncology Account Executive',title_original:'PRIVATE ORIGINAL TITLE',company_name:'PRIVATE EMPLOYER',description_text:'PRIVATE DESCRIPTION',source_url:'https://private.example/job',application_url:'https://private.example/apply',distance_miles:48,industry_classification:{labels:['Medical Device']},specialty_label:'Surgical',masked_lines:[[5,8,3,6],[7,4,8,3,5]],subscription_required:true,date_posted:'2026-09-10',freshness_label:'Posted 9 days ago',match:{overall_score:100,preference_fit:100,candidate_fit:null,recommendation:'Strong Match'}};
 const locked=render(base);
 if(file==='rook-dashboard-v7.html') {
  assert(locked.includes('<strong class="masked-role">Oncology Account Executive</strong>'));
  assert(locked.includes('class="masked-redaction" aria-hidden="true"'));
  assert.equal((locked.match(/class="masked-redaction-line"/g)||[]).length,2);
  assert(locked.includes('style="--mask-width:8"'));
  assert(locked.includes('Medical Device · Surgical'));
  assert(locked.includes('Company &amp; full job details hidden'));
 } else {assert(locked.includes('Job title and employer hidden'));assert(!locked.includes('masked-redaction'));}
 assert(locked.includes('48 miles away'));assert(locked.includes('Posted 9 days ago'));
 for(const secret of ['PRIVATE ORIGINAL TITLE','PRIVATE EMPLOYER','PRIVATE DESCRIPTION','private.example']) assert(!locked.includes(secret));
 if(file==='rook-dashboard-v7.html') {
  const other=render({...base,distance_miles:72,freshness_label:'Posted today',match:{...base.match,overall_score:93,preference_fit:93}});
  assert(other.includes('72 miles away'));assert(other.includes('93%'));assert(other.includes('Posted today'));
  assert(!other.includes('48 miles away')&&!other.includes('100%'));
 }
 assert(locked.includes('Preference Match'));assert(locked.includes('class="score-ring"'));
 assert(locked.includes('Strong Match'));assert(!locked.includes('Qualifications —%'));assert(!locked.includes('Posted 2026'));
 assert(locked.includes('not scored yet'));assert(locked.includes('rookGoToCheckout(\'job_card\')'));
 const full=render({...base,subscription_required:false,title_original:cases[0][0],company_name:'Axsome Therapeutics',source_url:'https://example.com/job',match:{overall_score:92,preference_fit:90,candidate_fit:96,recommendation:'Strong Match',categories:{}}});
 assert(full.includes('class="score-ring"'));assert(full.includes('Overall match: 92%'));assert(full.includes('Axsome Therapeutics'));assert(full.includes('Symbravo'));assert(full.includes('https://example.com/job'));assert(full.includes('Posted 2026-09-10'));assert(full.includes('Full category scoring'));
 const zero=render({...base,match:{overall_score:40,preference_fit:80,candidate_fit:0,recommendation:'Skip'}});assert(zero.includes('Match: 40%'));
 const unknown=render({...base,match:null});assert(unknown.includes('not scored'));assert(!unknown.includes('NaN'));
}
console.log('PASS masked title, unknown-brand, specialty, territory, freshness, immutability, both dashboards, partial/complete/zero/missing scores, unlocked source links, and checkout hook tests.');
module.exports={renderer};
// Execute the existing handlers with inert analytics transports: no production
// events, accounts, payment requests, or PII are emitted by these tests.
(async()=>{
 const root=require('node:path').join(__dirname,'../public');
 for(const version of ['v6','v7']) {
  const events=[],meta=[];const storage=new Map();const store={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const win={location:{href:''},ROOK_CONFIG:{},supabase:{createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})},gtag:(...args)=>events.push(args),fbq:(...args)=>meta.push(args)};
  const ctx={window:win,gtag:win.gtag,sessionStorage:store,localStorage:store,console};vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(root+'/rook-auth.js','utf8'),ctx);
  if(version==='v7') vm.runInContext(fs.readFileSync(root+'/rook-v7.js','utf8'),ctx);
  await vm.runInContext("rookGoToCheckout('job_card')",ctx);
  assert(events.some(e=>e[0]==='event'&&e[1]===(version==='v7'?'v7_unlock_clicked':'job_unlock_clicked')));
  assert.equal(win.location.href,version==='v7'?'rook-onboarding-v7-signup.html':'rook-checkout.html');
  vm.runInContext(fs.readFileSync(root+'/rook-tracking.js','utf8'),ctx);
  win.rookTrackFunnelEvent('v7_checkout_started',{email:'private@example.invalid',source:'job'});
  assert(meta.some(e=>e[0]==='trackSingle'&&e[2]==='InitiateCheckout'));
  assert(!JSON.stringify([...events,...meta]).includes('private@example.invalid'));
 }
 console.log('PASS existing V6/V7 unlock analytics, checkout destinations, GA4/Meta checkout mapping, and PII filtering.');
})().catch(e=>{console.error(e);process.exitCode=1;});
