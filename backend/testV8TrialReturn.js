const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const auth = fs.readFileSync('public/rook-auth-v8.js', 'utf8');
const flow = fs.readFileSync('public/rook-v8.js', 'utf8');
const html = fs.readFileSync('public/rook-onboarding-v8.html', 'utf8');
const trial = {subscription_status:'trialing',trial_ends_at:'2099-01-01',home_zip:'10001',desired_industries:['Diagnostics']};
const tick = () => new Promise(resolve => setImmediate(resolve));
function run(replies, {signedIn=true, hungAuth=false, analyticsError=false, storage={}}={}) {
  const elements = new Map();
  const calls=[], redirects=[], timers=new Map(), events=[];
  const saved = new Map(Object.entries(storage));
  let nextId=0;
  const context = vm.createContext({URLSearchParams,AbortController,URL,console,
    location:{search:'?trial=started',href:'https://rook.test/rook-onboarding-v8.html?trial=started',replace:url=>redirects.push(url)},
    document:{readyState:'loading',addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{hidden:false});return elements.get(id);}},
    sessionStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
    setTimeout:(fn,ms)=>{const id=++nextId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    gtag:(...args)=>{if(analyticsError)throw Error('blocked');events.push(args);},
    ROOK_CONFIG:{SUPABASE_URL:'https://auth.test',SUPABASE_ANON_KEY:'public',API_BASE:'/api'},
    supabase:{createClient:()=>({auth:{getSession:()=>hungAuth?new Promise(()=>{}):Promise.resolve({data:{session:signedIn?{access_token:'verified-token'}:null}})}})},
    fetch:async (url,options)=>{
      calls.push({url,options});
      const reply=replies.length>1?replies.shift():replies[0];
      if(reply instanceof Error)throw reply;
      if(reply==='hang')return new Promise(()=>{});
      return {ok:!(reply?.http>=400),status:reply?.http||200,json:async()=>reply};
    }
  });
  context.window=context;
  vm.runInContext(auth,context);vm.runInContext(flow,context);
  return {elements,calls,redirects,saved,events,context,async advance(ms){await tick();const entry=[...timers].find(([,v])=>v.ms===ms);assert.ok(entry,`timer ${ms}`);timers.delete(entry[0]);entry[1].fn();await tick();}};
}
test('activation gate is parsed before styles/body and normal onboarding stays available without success flag',()=>{
  const gate=html.match(/<script>(if\(new URLSearchParams[\s\S]*?)<\/script>/)[1];
  for(const [search,expected] of [['?trial=started',true],['?trial=cancelled',false],['',false]]){
    let gated=false;vm.runInNewContext(gate,{URLSearchParams,location:{search},document:{documentElement:{classList:{add:()=>gated=true}}}});assert.equal(gated,expected);
  }
  assert.ok(html.indexOf('trial-activating')<html.indexOf('<body>'));
  assert.match(html,/html\.trial-activating body > :not\(#trialActivation\)\{display:none!important\}/);
});
test('delayed entitlement polls without attaching onboarding or rendering masked jobs, then redirects once',async()=>{
  const original={rook_v7_token:'saved-search',rook_v8_active:'saved-search',preferences:'10001/Diagnostics'};
  const r=run([{subscription_status:'none'},null,trial],{storage:original});await tick();
  assert.equal(r.redirects.length,0);assert.equal(r.elements.has('searchForm'),false);assert.equal(r.elements.has('jobGrid'),false);
  await r.advance(2000);assert.equal(r.redirects.length,0);await r.advance(2000);
  assert.deepEqual(r.redirects,['rook-dashboard-v8.html']);assert.equal(r.calls.length,3);
  for(const {url,options} of r.calls){assert.equal(url,'/api/profile');assert.equal(options.headers.Authorization,'Bearer verified-token');assert.equal(options.cache,'no-store');assert.equal(options.method,undefined);}
  for(const [key,value] of Object.entries(original))assert.equal(r.saved.get(key),value);
});
for(const [label,profile] of [['trial',trial],['paid',{subscription_status:'active'}]])test(`existing ${label} member works without preview storage and on refresh`,async()=>{
  for(let i=0;i<2;i++){const r=run([profile]);await tick();assert.deepEqual(r.redirects,['rook-dashboard-v8.html']);assert.equal(r.calls.length,1);}
});
for(const [label,profile] of [['unpaid',{subscription_status:'none'}],['cancelled',{subscription_status:'cancelled'}],['expired trial',{...trial,trial_ends_at:'2000-01-01'}],['expired cancellation',{subscription_status:'active',subscription_cancel_at:'2000-01-01'}],['failed payment',{subscription_status:'incomplete'}]])test(`${label} never unlocks from return parameter; polling is bounded and retry works`,async()=>{
  const replies=[profile],r=run(replies);await tick();for(let i=0;i<9;i++)await r.advance(2000);
  assert.equal(r.calls.length,10);assert.equal(r.redirects.length,0);assert.equal(r.elements.get('trialActivationRetry').hidden,false);
  assert.equal(r.elements.has('searchForm'),false);replies[0]=trial;
  await r.elements.get('trialActivationRetry').onclick();assert.deepEqual(r.redirects,['rook-dashboard-v8.html']);
});
test('signed-out or invalid authentication stays locked and offers sign-in; login return verifies again',async()=>{
  for(const http of [401,403]){const r=run([{http}],{signedIn:false});await tick();assert.equal(r.calls.length,1);assert.equal(r.redirects.length,0);assert.equal(r.elements.get('trialActivationLogin').hidden,false);r.elements.get('trialActivationLogin').onclick();assert.match(r.saved.get('rook_login_return'),/trial=started/);}
  const loggedIn=run([trial]);await tick();assert.equal(loggedIn.redirects.length,1);
});
test('transient network/server errors retry without clearing saved state',async()=>{
  const r=run([Error('network'),{http:503},trial],{storage:{rook_v8_active:'saved'}});await tick();await r.advance(2000);await r.advance(2000);assert.equal(r.redirects.length,1);assert.equal(r.saved.get('rook_v8_active'),'saved');
});
test('hung authentication or network requests hit the overall deadline',async()=>{
  for(const hungAuth of [true,false]){const r=run(['hang'],{hungAuth});await r.advance(25000);assert.equal(r.redirects.length,0);assert.equal(r.elements.get('trialActivationRetry').hidden,false);}
});
test('analytics failure cannot interrupt redirect, and recorded conversions are not repeated',async()=>{
  const r=run([trial],{analyticsError:true});await tick();assert.equal(r.redirects.length,1);
  const repeated=run([trial],{storage:{rook_trial_activated_fired:'1'}});await tick();assert.equal(repeated.redirects.length,1);assert.equal(repeated.events.length,0);
});
