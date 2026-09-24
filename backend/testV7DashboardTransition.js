const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
function setup({pending=true,creating=false,fail=false}={}){
 const answers={location:{lat:42,lng:-71,zip:'02108'},industry:'Veterinary',years:0,territories:['remote'],preparation:'prepared',attribution:{utm_source:'test'}};
 const store=new Map([['rook_v7_token','old']]);if(pending)store.set('rook_v7_pending',JSON.stringify(answers));if(creating)store.set('rook_v7_creating','interrupted');
 let finish;const calls=[];const context={crypto,sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},fetch:(path,options)=>{calls.push({path,options});return new Promise(resolve=>finish=()=>resolve({ok:!fail,json:async()=>fail?{error:'Unavailable'}:{token:'new'}}));}};
 context.window=context;vm.runInNewContext(fs.readFileSync('public/rook-v7.js','utf8'),context);return {context,store,calls,answers,finish:()=>finish()};
}
test('dashboard owns one unchanged request and preserves the optimized initial result reuse',async()=>{
 const b=setup();const first=b.context.rookV7FinishOnboarding(),second=b.context.rookV7FinishOnboarding();assert.equal(first,second);assert.equal(b.calls.length,1);assert.equal(b.calls[0].path,'/api/v7/session');assert.deepEqual(JSON.parse(b.calls[0].options.body),b.answers);assert.equal(b.store.has('rook_v7_pending'),false);b.finish();await first;assert.equal(b.store.get('rook_v7_token'),'new');assert.equal(b.store.get('rook_v7_initial'),'new');assert.equal(b.store.has('rook_v7_creating'),false);
});
test('interruption, backend failure and superseded answers cannot expose a stale session or repeat submission',async()=>{
 const interrupted=setup({pending:false,creating:true});await assert.rejects(interrupted.context.rookV7FinishOnboarding(),/interrupted/);assert.equal(interrupted.calls.length,0);
 const failed=setup({fail:true});const f=failed.context.rookV7FinishOnboarding();failed.finish();await assert.rejects(f,/Unavailable/);assert(failed.store.has('rook_v7_creating'));assert.equal(failed.store.get('rook_v7_token'),'old');
 const revised=setup();const r=revised.context.rookV7FinishOnboarding();revised.store.set('rook_v7_creating','newer-request');revised.finish();await assert.rejects(r,/changed/);assert.equal(revised.store.get('rook_v7_token'),'old');
 const existing=setup({pending:false});await existing.context.rookV7FinishOnboarding();assert.equal(existing.calls.length,0);
});
test('onboarding markup, backend, popup logic and existing skeletons remain unchanged',()=>{
 const old=file=>execFileSync('git',['show','HEAD:'+file],{encoding:'utf8'}),current=file=>fs.readFileSync(file,'utf8');
 const onboarding='public/rook-onboarding-v7.html';assert.equal(current(onboarding).split('<script>')[0],old(onboarding).split('<script>')[0]);
 for(const file of ['backend/v7Matching.js','backend/v7Preparation.js','backend/routes/onboardingV7.js','backend/matching.js','backend/v7Location.js','public/rook-pretrial-alerts.js','public/rook-pretrial.js'])assert.equal(current(file),old(file),file);
 const dashboard='public/rook-dashboard-v7.html',skeleton=s=>s.slice(s.indexOf('<div id="jobListLoading"'),s.indexOf('<div class="job-list"'));assert.equal(skeleton(current(dashboard)),skeleton(old(dashboard)));
});
