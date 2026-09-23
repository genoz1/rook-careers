const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {sendPretrialDigest,renderPretrialDigest}=require('./email/pretrialDigest');
const job={id:'private-id',company_name:'HiddenEmployer',title_original:'SecretBrand Territory Executive',source_url:'https://secret.example',location_raw:'Private Place',first_seen_at:new Date().toISOString(),match:{overall_score:85},category:'territory sales',industry:'medical device'};
const lead={id:'lead',email:'test@example.invalid',digest_enabled:true,consent_at:new Date(Date.now()-86400000).toISOString(),profile:{},unsubscribe_token:'a'.repeat(64)};
function dbMock() {
 const rows=[];let eligible=true;
 return {rows,setEligible(v){eligible=v;},rpc:async()=>({data:eligible}),from(){return {select(){return this;},eq(){return this;},in(){return Promise.resolve({data:rows});},async insert(values){if(values.some(v=>rows.some(r=>r.job_id===v.job_id))) return {error:{code:'23505'}};rows.push(...values);return {};}}}};
}
test('emails use the strict dashboard allowlist and contain unsubscribe and masked CTA',()=>{
 const html=renderPretrialDigest([job],'https://rookcareers.com',lead.unsubscribe_token);
 assert(!/HiddenEmployer|SecretBrand|private-id|secret.example|Private Place/.test(html));
 assert.match(html,/View My Matches/);assert.match(html,/alerts\/unsubscribe/);
});
test('new matches only, durable dedup, opt-outs, existing accounts, and ambiguous send',async()=>{
 let sends=0;const db=dbMock(),deps={rank:async()=>[job],sendEmail:async()=>{sends++}};
 assert.equal((await sendPretrialDigest(db,lead,'https://rookcareers.com',deps)).sent,true);
 assert.equal((await sendPretrialDigest(db,lead,'https://rookcareers.com',deps)).sent,false);assert.equal(sends,1);
 assert.equal((await sendPretrialDigest(db,{...lead,digest_enabled:false},'',deps)).reason,'opted_out');
 db.setEligible(false);assert.equal((await sendPretrialDigest(db,lead,'',deps)).sent,false);
 for(const candidate of [{...job,first_seen_at:'2020-01-01'},{...job,match:{overall_score:59}}]) assert.equal((await sendPretrialDigest(dbMock(),lead,'',{...deps,rank:async()=>[candidate]})).reason,'no_new_matches');
 const failed=dbMock();await assert.rejects(sendPretrialDigest(failed,lead,'',{...deps,sendEmail:async()=>{throw Error('timeout')}}));
 assert.equal((await sendPretrialDigest(failed,lead,'',deps)).reason,'already_sent');
});
test('concurrent digest workers cannot send the same job twice',async()=>{
 const db=dbMock();let sends=0;const deps={rank:async()=>[job],sendEmail:async()=>{sends++}};
 await Promise.all([sendPretrialDigest(db,lead,'',deps),sendPretrialDigest(db,lead,'',deps)]);assert.equal(sends,1);
});
function browser({email,authenticated=false,mobile=false,skipped=false,snapshot={}}={}) {
 const state=new Map(),events=[],nodes=[],listeners={};let now=1000,request;
 if(email)state.set('rook_alert_email',email);if(skipped)state.set('rook_alert_skipped','1');
 const document={body:{append:n=>nodes.push(n)},querySelector:()=>null,addEventListener:(k,f)=>listeners[k]=f,removeEventListener:k=>delete listeners[k],createElement:()=>{
  const elements={};return {style:{},setAttribute(){},querySelector:k=>elements[k] ||= {},addEventListener:(k,f)=>elements[k]=f,showModal(){this.open=true},close(){this.open=false},remove(){}};
 }};
 const context={document,sessionStorage:{getItem:k=>state.get(k),setItem:(k,v)=>state.set(k,v)},location:{search:'',href:''},Date:{now:()=>now},URLSearchParams,AbortSignal,navigator:{maxTouchPoints:mobile?1:0},matchMedia:()=>({matches:!mobile}),rookV7Snapshot:snapshot,rookV7Unlocked:false,rookV7Auth:()=>({auth:{getSession:async()=>({data:{session:authenticated?{}:null}})}}),rookV7Request:async(path,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true})}},rookTrackFunnelEvent:(...a)=>events.push(a)};
 context.window=context;vm.runInNewContext(fs.readFileSync(require.resolve('../public/rook-pretrial-alerts.js'),'utf8'),context);
 return {api:context.rookPretrialAlerts,state,events,nodes,listeners,context,setNow:v=>now=v,request:()=>request};
}
test('first prompt skips immediately and successful capture sends explicit consent and prefills later',async()=>{
 let b=browser();await b.api.first();assert.equal(b.nodes.length,1);b.nodes[0].querySelector('[data-skip]').onclick();assert.equal(b.context.location.href,'rook-dashboard-v7.html');assert.equal(b.state.get('rook_alert_skipped'),'1');
 b=browser();await b.api.first();b.nodes[0].querySelector('input').value='Example@Example.invalid';await b.nodes[0].querySelector('form').onsubmit({preventDefault(){}});
 assert.equal(b.request().consent,true);assert.equal(b.request().source,'onboarding');assert.equal(b.api.email(),'example@example.invalid');assert.equal(b.context.location.href,'rook-dashboard-v7.html');
 await b.api.first();assert.equal(b.nodes.length,1);
});
test('authenticated and already captured visitors bypass first prompt',async()=>{
 for(const options of [{authenticated:true},{email:'a@example.invalid'}]) {const b=browser(options);await b.api.first();assert.equal(b.nodes.length,0);assert.equal(b.context.location.href,'rook-dashboard-v7.html');}
});
test('desktop exit is optional, once per session, and omitted for mobile/captured/trial visitors',async()=>{
 const b=browser({skipped:true});await b.api.dashboard();b.setNow(20000);await b.listeners.mouseout({relatedTarget:null,clientY:0});assert.equal(b.nodes.length,1);b.nodes[0].querySelector('[data-skip]').onclick();assert.equal(b.nodes[0].open,false);await b.api.dashboard();assert.equal(b.listeners.mouseout,undefined);
 for(const options of [{mobile:true},{authenticated:true},{email:'a@example.invalid'},{snapshot:{alert_requested:true}}]) {const c=browser({skipped:true,...options});await c.api.dashboard();assert.equal(c.listeners.mouseout,undefined);}
 const c=browser({skipped:true});c.api.trial();await c.api.dashboard();assert.equal(c.listeners.mouseout,undefined);
});
