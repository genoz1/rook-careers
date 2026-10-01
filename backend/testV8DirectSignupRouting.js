const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/rook-v8.js', 'utf8');
const handlerMatch = source.match(/\$\('searchForm'\)\.onsubmit=(async e=>\{[\s\S]*?\n  \});\n  async function init/);
assert.ok(handlerMatch, 'V8 submit handler must remain discoverable');
const goSignupMatch = source.match(/(function goSignup[^\n]+)/);
assert.ok(goSignupMatch, 'V8 signup navigation must remain discoverable');

function element(extra = {}) {
  return {value:'', textContent:'', hidden:true, disabled:false, dataset:{}, focus(){}, querySelector(){return button}, ...extra};
}

const button = element();

function strictBrowserLocation(search) {
  let current = `https://rookcareers.com/rook-onboarding-v8.html${search}`;
  return {
    search,
    origin:'https://rookcareers.com',
    get href(){return current;},
    set href(value){
      if (!/^https:\/\//.test(value)) throw new DOMException('The string did not match the expected pattern.', 'SyntaxError');
      current=value;
    },
    assign(value){this.href=value;},
  };
}

async function runCase({selectedLocation, industry, search}) {
  const saved = new Map();
  const events = [];
  const calls = [];
  const location = strictBrowserLocation(search);
  const elements = new Map([
    ['searchForm', element()], ['formError', element()], ['searchProgress', element()],
    ['searchProgressText', element()], ['industryInput', element({value:industry})], ['jobGrid', element()],
  ]);
  elements.get('searchForm').querySelector = () => button;
  const context = vm.createContext({
    URL, URLSearchParams, DOMException, crypto:{randomUUID:()=> 'search-1'}, performance:{now:()=>10},
    location, selectedLocation, busy:false, preparation:null,
    sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)},
    $:id=>elements.get(id),
    track:(name,details={})=>events.push({name,details}),
    api:async(path,options)=>{calls.push({path,options});return {token:'v8-session-token',preview:{jobs:[],profile:{},count:0}};},
    displayPreview:()=>assert.fail('new V8 onboarding must not render the masked dashboard'),
    requestAnimationFrame:()=>assert.fail('new V8 onboarding must not schedule preview rendering'),
    setInterval:()=>1, clearInterval(){}, Date,
  });
  context.window=context;
  context.goSignup=vm.runInContext(`(${goSignupMatch[1]})`, context);

  const handler = vm.runInContext(`(${handlerMatch[1]})`, context);
  await handler({preventDefault(){}});

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/session');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.location, selectedLocation);
  assert.equal(body.industry, industry);
  assert.equal(saved.get('rook_v7_token'), 'v8-session-token');
  assert.equal(saved.get('rook_v8_active'), 'v8-session-token');
  assert.equal(location.href, 'https://rookcareers.com/rook-onboarding-v8-signup.html');
  assert.equal(elements.get('formError').textContent, '');
  assert(events.some(event=>event.name==='v8_signup_reached'));
  assert(!events.some(event=>event.name==='v8_masked_unlock_interaction'));
  assert(!events.some(event=>event.name==='v8_trial_started'));
  assert(!events.some(event=>event.name==='v8_preview_results_received'));
  assert.deepEqual(calls.map(call=>call.path), ['/session']);
  return body;
}

test('initial V8 questions route directly to verified signup for exact Oxford selection and other valid locations', async () => {
  const oxford=await runCase({
    selectedLocation:{lat:28.9,lng:-82,city:'Oxford',stateAbbr:'FL',zip:'34484',label:'34484 — Oxford, FL'},
    industry:'Diagnostics', search:'?utm_source=google&utm_medium=cpc&utm_campaign=v8-direct&gclid=click-1',
  });
  assert.equal(oxford.attribution.utm_source,'google');
  assert.equal(oxford.attribution.utm_medium,'cpc');
  assert.equal(oxford.attribution.utm_campaign,'v8-direct');
  assert.equal(oxford.attribution.gclid,'click-1');

  await runCase({
    selectedLocation:{lat:28.9,lng:-82,city:'Oxford',stateAbbr:'FL',zip:'34484',label:'34484'},
    industry:'Diagnostics', search:'',
  });
  await runCase({
    selectedLocation:{lat:39.7392,lng:-104.9903,city:'Denver',stateAbbr:'CO',zip:'80202',label:'Denver, CO'},
    industry:'Medical Device', search:'?utm_source=facebook&utm_medium=paid_social&utm_campaign=denver',
  });
});

test('signup still claims the preserved V8 token only after verified authentication', () => {
  const signup = fs.readFileSync('public/rook-onboarding-v8-signup.html', 'utf8');
  assert.match(signup, /verifyOtp\([\s\S]*await claimAndRoute\(data\.session\)/);
  assert.match(signup, /fetch\('\/api\/v8\/claim'[\s\S]*'X-ROOK-V7':sessionStorage\.getItem\('rook_v7_token'\)/);
  assert.match(signup, /result\.outcome==='started'[\s\S]*rook-onboarding-v8\.html\?trial=started/);
});
