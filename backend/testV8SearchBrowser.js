const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/rook-v8.js','utf8');
const preview={profile:{home_location_label:'Test city'},unlocked:false,count:3,jobs:Array.from({length:3},(_,i)=>({id:'locked-'+i,subscription_required:true,role_type:'Field Sales',match:{overall_score:80}}))};
function run({failure=false,legacy=false,analyticsError=false}={}){
 const elements=new Map(),events=[],calls=[],frames=[],saved=new Map();let select,clock=0;
 let currentUrl='https://rookcareers.com/rook-onboarding-v8.html';
 const location={search:'',origin:'https://rookcareers.com',replace(){},get href(){return currentUrl;},set href(value){if(!/^https:\/\//.test(value))throw new DOMException('The string did not match the expected pattern.','SyntaxError');currentUrl=value;},assign(value){this.href=value;}};
 const el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},value:id==='industryInput'?'Diagnostics':'',hidden:false,querySelector:()=>el('submit'),querySelectorAll:()=>[],focus(){}});return elements.get(id);};
 const ctx={URL,URLSearchParams,DOMException,AbortSignal,Date,crypto:{randomUUID:()=> 'non-identifying-search-id'},performance:{now:()=>++clock},
 document:{getElementById:el},location,sessionStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
 setInterval:()=>1,clearInterval(){},requestAnimationFrame:fn=>frames.push(fn),
 rookSupabase:{auth:{getSession:async()=>{calls.push('auth');return {data:{session:null}};}}},
 RookLocationWidget:{init:opts=>{select=opts.onSelect;}},RookV8EmployerLogo:{render:()=>''},
 gtag:(_,name,params)=>{if(analyticsError)throw Error('blocked');events.push({name,params,at:calls.length});},
 fetch:async(url,options)=>{calls.push(url);if(url.endsWith('/prepare'))return {ok:true,json:async()=>({preparation:'prepared-token'})};if(failure)return {ok:false,status:503,json:async()=>({error:'Raw secret error'})};return {ok:true,json:async()=>options.method==='POST'?{token:'new-token',...(legacy?{}:{preview})}:preview};}
 };ctx.window=ctx;vm.runInNewContext(source,ctx);
 return {select,el,events,calls,frames,location,async submit(){await el('searchForm').onsubmit({preventDefault(){}});},paint(){while(frames.length)frames.shift()();}};
}
test('valid submit fires requested before auth/network and routes directly to signup without a masked preview',async()=>{
 const r=run();r.select({lat:28.9,lng:-82,stateAbbr:'FL',zip:'34484'});await new Promise(setImmediate);r.calls.length=0;
 await r.submit();const requested=r.events.find(e=>e.name==='v8_show_my_jobs_requested');assert.equal(requested.at,0);
 assert.deepEqual(r.calls,['auth','/api/v8/session']);assert.equal(r.location.href,'https://rookcareers.com/rook-onboarding-v8-signup.html');
 for(const name of ['v8_overlay_submitted','v8_initial_search_succeeded','v8_signup_reached'])assert(r.events.some(e=>e.name===name),name);
 for(const name of ['v8_preview_results_received','v8_preview_results_rendered','v8_search_elapsed_time','v8_trial_started'])assert(!r.events.some(e=>e.name===name),name);
 for(const e of r.events.filter(e=>e.params.search_id))assert.deepEqual(Object.keys(e.params).filter(k=>!['onboarding_version','search_id','elapsed_ms','job_count'].includes(k)),[]);
});
test('failure category never includes raw errors; invalid selection never records an attempt',async()=>{
 const r=run({failure:true});await r.submit();assert(!r.events.some(e=>e.name==='v8_show_my_jobs_requested'));
 r.select({lat:1,lng:2,stateAbbr:'FL',zip:'34484'});await r.submit();
 assert.equal(r.events.find(e=>e.name==='v8_initial_search_failed').params.error_category,'server');assert(!JSON.stringify(r.events).includes('Raw secret'));
});
test('blocked analytics cannot prevent direct signup navigation',async()=>{
 const r=run({analyticsError:true});r.select({lat:1,lng:2,stateAbbr:'FL',zip:'34484'});await r.submit();assert.equal(r.location.href,'https://rookcareers.com/rook-onboarding-v8-signup.html');
});
