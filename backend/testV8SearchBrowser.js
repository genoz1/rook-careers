const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/rook-v8.js','utf8');
const preview={profile:{home_location_label:'Test city'},unlocked:false,count:3,jobs:Array.from({length:3},(_,i)=>({id:'locked-'+i,subscription_required:true,role_type:'Field Sales',match:{overall_score:80}}))};
function run({failure=false,legacy=false,analyticsError=false}={}){
 const elements=new Map(),events=[],calls=[],frames=[],saved=new Map();let select,clock=0;
 const el=id=>{if(!elements.has(id))elements.set(id,{dataset:{},value:id==='industryInput'?'Diagnostics':'',hidden:false,querySelector:()=>el('submit'),querySelectorAll:()=>[],focus(){},addEventListener(){}});return elements.get(id);};
 const ctx={URL,URLSearchParams,AbortSignal,Date,crypto:{randomUUID:()=> 'non-identifying-search-id'},performance:{now:()=>++clock},
 document:{getElementById:el},location:{search:'',replace(){}},sessionStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
 setInterval:()=>1,clearInterval(){},requestAnimationFrame:fn=>frames.push(fn),
 rookSupabase:{auth:{getSession:async()=>{calls.push('auth');return {data:{session:null}};}}},
 RookLocationWidget:{init:opts=>{select=opts.onSelect;}},RookV8EmployerLogo:{render:()=>''},
 gtag:(_,name,params)=>{if(analyticsError)throw Error('blocked');events.push({name,params,at:calls.length});},
 fetch:async(url,options)=>{calls.push(url);if(url.endsWith('/prepare'))return {ok:true,json:async()=>({preparation:'prepared-token'})};if(failure)return {ok:false,status:503,json:async()=>({error:'Raw secret error'})};return {ok:true,json:async()=>options.method==='POST'?{token:'new-token',...(legacy?{}:{preview})}:preview};}
 };ctx.window=ctx;vm.runInNewContext(source,ctx);
 return {select,el,events,calls,frames,async submit(){await el('searchForm').onsubmit({preventDefault(){}});},paint(){while(frames.length)frames.shift()();}};
}
test('valid submit fires requested before auth/network; fresh POST renders without GET; paint timing is deferred',async()=>{
 const r=run();r.select({lat:28.9,lng:-82,stateAbbr:'FL',zip:'34484'});await new Promise(setImmediate);r.calls.length=0;
 await r.submit();const requested=r.events.find(e=>e.name==='v8_show_my_jobs_requested');assert.equal(requested.at,0);
 assert.deepEqual(r.calls,['auth','/api/v8/session']);assert(r.el('jobGrid').innerHTML.includes('job-card'));
 assert(!r.events.some(e=>e.name==='v8_preview_results_rendered'));r.paint();
 for(const name of ['v8_overlay_submitted','v8_initial_search_succeeded','v8_preview_results_received','v8_preview_results_rendered','v8_search_elapsed_time'])assert(r.events.some(e=>e.name===name),name);
 for(const e of r.events.filter(e=>e.params.request_id))assert.deepEqual(Object.keys(e.params).filter(k=>!['onboarding_version','request_id','elapsed_bucket_ms','job_count'].includes(k)),[]);
});
test('failure category never includes raw errors; invalid selection never records an attempt',async()=>{
 const r=run({failure:true});await r.submit();assert(!r.events.some(e=>e.name==='v8_show_my_jobs_requested'));
 r.select({lat:1,lng:2,stateAbbr:'FL',zip:'34484'});await r.submit();
 assert.equal(r.events.find(e=>e.name==='v8_initial_search_failed').params.error_category,'server');assert(!JSON.stringify(r.events).includes('Raw secret'));
});
test('rolling deployment fallback and blocked analytics remain usable',async()=>{
 for(const options of [{legacy:true},{analyticsError:true}]){const r=run(options);r.select({lat:1,lng:2,stateAbbr:'FL',zip:'34484'});await r.submit();r.paint();assert(r.el('jobGrid').innerHTML.includes('job-card'));}
});
