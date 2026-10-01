const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/rook-v8.js', 'utf8');
const handlerMatch = source.match(/\$\('searchForm'\)\.onsubmit=(async e=>\{[\s\S]*?\n  \});\n  async function init/);
assert.ok(handlerMatch, 'V8 submit handler must remain discoverable');

function element(extra = {}) {
  return {value:'', textContent:'', hidden:true, disabled:false, dataset:{}, focus(){}, querySelector(){return button}, ...extra};
}

const button = element();

test('initial V8 questions preserve session and attribution, then route directly to verified signup', async () => {
  const saved = new Map();
  const events = [];
  const calls = [];
  const location = {search:'?utm_source=google&utm_campaign=v8-direct&gclid=click-1', href:'rook-onboarding-v8.html'};
  const selectedLocation = {lat:28.9,lng:-82,city:'Oxford',stateAbbr:'FL',zip:'34484',label:'Oxford, FL'};
  const elements = new Map([
    ['searchForm', element()], ['formError', element()], ['searchProgress', element()],
    ['searchProgressText', element()], ['industryInput', element({value:'Diagnostics'})], ['jobGrid', element()],
  ]);
  elements.get('searchForm').querySelector = () => button;
  const context = vm.createContext({
    URLSearchParams, crypto:{randomUUID:()=> 'search-1'}, performance:{now:()=>10},
    location, selectedLocation, busy:false, preparation:null,
    sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)},
    $:id=>elements.get(id),
    track:(name,details={})=>events.push({name,details}),
    api:async(path,options)=>{calls.push({path,options});return {token:'v8-session-token',preview:{jobs:[],profile:{},count:0}};},
    goSignup:(source,maskedInteraction=true)=>{
      if(maskedInteraction)events.push({name:'v8_masked_unlock_interaction',details:{source}});
      events.push({name:'v8_signup_reached',details:{}});
      location.href='rook-onboarding-v8-signup.html';
    },
    displayPreview:()=>assert.fail('new V8 onboarding must not render the masked dashboard'),
    requestAnimationFrame:()=>assert.fail('new V8 onboarding must not schedule preview rendering'),
    setInterval:()=>1, clearInterval(){}, Date,
  });

  const handler = vm.runInContext(`(${handlerMatch[1]})`, context);
  await handler({preventDefault(){}});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/session');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.location, selectedLocation);
  assert.equal(body.industry, 'Diagnostics');
  assert.equal(body.attribution.utm_source, 'google');
  assert.equal(body.attribution.utm_campaign, 'v8-direct');
  assert.equal(body.attribution.gclid, 'click-1');
  assert.equal(saved.get('rook_v7_token'), 'v8-session-token');
  assert.equal(saved.get('rook_v8_active'), 'v8-session-token');
  assert.equal(location.href, 'rook-onboarding-v8-signup.html');
  assert(events.some(event=>event.name==='v8_signup_reached'));
  assert(!events.some(event=>event.name==='v8_masked_unlock_interaction'));
  assert(!events.some(event=>event.name==='v8_trial_started'));
  assert(!events.some(event=>event.name==='v8_preview_results_received'));
});

test('signup still claims the preserved V8 token only after verified authentication', () => {
  const signup = fs.readFileSync('public/rook-onboarding-v8-signup.html', 'utf8');
  assert.match(signup, /verifyOtp\([\s\S]*await claimAndRoute\(data\.session\)/);
  assert.match(signup, /fetch\('\/api\/v8\/claim'[\s\S]*'X-ROOK-V7':sessionStorage\.getItem\('rook_v7_token'\)/);
  assert.match(signup, /result\.outcome==='started'[\s\S]*rook-onboarding-v8\.html\?trial=started/);
});
