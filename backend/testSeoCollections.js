const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {VERSION,descriptionHash}=require('./jobLocationScope');
const {CATEGORIES,FLORIDA,buildCollections,floridaKind,createInventoryLoader}=require('./seoInventory');
const {PAGE_SIZE}=require('./seoCollections');
const PUBLIC='https://rookcareers.com';
function job(i,labels=['Medical Device','Pharmaceutical','Diagnostics','Capital Equipment']) {
 const row={id:`11111111-1111-4111-8111-${String(i).padStart(12,'0')}`,employer_id:'employer-'+(i%4),company_name:'SecretEmployer'+(i%4),source_job_id:'PrivateReq'+i,source_url:'https://secret.example/job/'+i,application_url:'https://secret.example/apply/'+i,title_original:'BrandSecret Territory Sales Representative',title_normalized:'PrivateTitle',description_text:'PrivateDescription',location_raw:'Tampa, FL, United States',city:'Tampa',state:'FL',job_lat:27.95,job_lng:-82.46,ai_analysis:{product_categories:labels,summary:'PrivateAISummary'},status:'active',moderation_status:'approved',date_posted:'2026-09-01',category:'field sales',employment_type:'full-time'};
 row.location_evidence={version:VERSION,status:'validated',source_location:row.location_raw,source_title:row.title_original,source_description_hash:descriptionHash(row.description_text),source_country_code:'US',scope:{kind:'local'},locations:[{lat:27.95,lng:-82.46,state:'FL'}]};return row;
}
let rows=Array.from({length:65},(_,i)=>job(i));rows.push(...Array.from({length:23},(_,i)=>job(i+100,['Veterinary'])));
let fail=false,calls=0;
const db={from:(table)=>{let filters=[],offset=0,end=Infinity,single=false,cols;const q={select(c){cols=c;return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(){return q;},lte(){return q;},limit(){return q;},order(){return q;},range(a,b){offset=a;end=b;return q;},maybeSingle(){single=true;return q;},then(resolve,reject){calls++;const d=(table==='resource_articles'?[]:rows).filter(r=>filters.every(f=>f(r))).sort((a,b)=>a.id.localeCompare(b.id)).slice(offset,Math.min(end+1,offset+17)).map(r=>Object.fromEntries(cols.split(',').map(k=>[k.trim(),r[k.trim()]])));return Promise.resolve({data:single?d[0]||null:d,error:fail?{message:'temporary'}:null}).then(resolve,reject);}};return q;}};
const noSecrets=html=>{for(const s of ['SecretEmployer','PrivateReq','secret.example','BrandSecret','PrivateTitle','PrivateDescription','PrivateAISummary','JobPosting'])assert(!html.includes(s),s);};
test('inventory eligibility, market union, deduplication and genuine Florida scope',()=>{
 const base=job(1),duplicate={...base,id:job(2).id};
 const inactive={...job(3),status:'expired'},pending={...job(4),moderation_status:'pending'};
 const foreign={...job(5),location_raw:'Paris, France',location_evidence:{status:'foreign',source_country_code:'FR'}};
 const remote=job(6);remote.location_evidence.scope={kind:'remote_us',states:['FL']};
 const territory=job(7);territory.location_evidence.scope={kind:'territory',states:['Florida']};
 const stale=job(8);stale.description_text='changed';
 const unvalidated=job(9);unvalidated.location_evidence.status='unresolved';
 const legacy=job(10);legacy.location_evidence.version=VERSION-1;
 const veto=job(11,['Veterinary','Medical Device']);
 const source=[base,duplicate,inactive,pending,foreign,remote,territory,stale,unvalidated,legacy,veto];
 const before=JSON.stringify(source),c=buildCollections(source),national=c['/jobs/category/medical-sales-jobs'],fl=c['/jobs/category/medical-sales-jobs/florida'];
 assert.equal(fl.count,2);assert.equal(national.count,5);assert.equal(c['/jobs/category/veterinary-sales-jobs'].count,1);
 assert.equal(JSON.stringify(source),before);noSecrets(JSON.stringify(c));
 assert.equal(floridaKind(remote),null);assert.equal(floridaKind(territory),'territory');
 const noFl=job(12);noFl.location_evidence.locations[0].state='TX';assert.equal(floridaKind(noFl),null);
 const renamed=job(13);renamed.title_original='changed';assert.equal(floridaKind(renamed),null);
});
test('full pagination through database caps; short safe cache; failures do not become empty inventory',async()=>{
 const loader=createInventoryLoader(db,{ttl:1});const c=await loader();assert.equal(c['/jobs/category/medical-sales-jobs'].count,65);assert.equal(c['/jobs/category/veterinary-sales-jobs'].count,23);assert(calls>=6);noSecrets(JSON.stringify(c));
 fail=true;await new Promise(r=>setTimeout(r,5));await assert.rejects(loader(),/unavailable/);fail=false;
});
test('production routing: existing industry, role and Florida pages, privacy, pagination, canonicals, schema, sitemap, filters, private headers and application compatibility',async()=>{
 process.env.SUPABASE_URL='https://test.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='test';process.env.PUBLIC_APP_URL=PUBLIC;
 require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
 require.cache[require.resolve('./routes/stripe')]={exports:{getTrialPeriodDays:()=>3}};
 const express=require('express');let app;
 // Execute real server routing/static configuration without starting background workers.
 function fakeExpress(){app=express();app.listen=()=>null;return app;}Object.assign(fakeExpress,express);
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),{require(name){if(name==='express')return fakeExpress;if(name==='dotenv')return {config(){}};if(name==='path')return path;if(name==='./backend/routes/publicPages')return require('./routes/publicPages');if(name==='./backend/publicSeo')return require('./publicSeo');if(name==='./backend/socialShortLinks')return {createRouter:()=>express.Router()};if(name==='./backend/resources/routes')return {createRouter:()=>express.Router()};if(name==='fs')return fs;return express.Router();},__dirname:path.join(__dirname,'..'),process:{env:process.env,on(){}},console,URLSearchParams});
 const server=express.application.listen.call(app,0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 const get=p=>fetch(origin+p,{redirect:'manual'});
 try {
  const titles=new Set(),descriptions=new Set();
  for(const slug of Object.keys(CATEGORIES))for(const florida of [false,true]){
   if(florida&&!FLORIDA.includes(slug))continue;const p='/jobs/category/'+slug+(florida?'/florida':'');
   const r=await get(p);assert.equal(r.status,200,p);const html=await r.text();noSecrets(html);
   assert.equal(html.includes('content="noindex'),!buildCollections(rows)[p].qualified);assert(html.includes(`rel="canonical" href="${PUBLIC+p}"`));assert(html.includes('aria-label="Breadcrumb"'));assert(html.includes('aria-current="page">'+(florida?'Florida':CATEGORIES[slug].label.replace('&','&amp;'))));
   const count=buildCollections(rows)[p].count;assert(html.includes(`data-company-count="${buildCollections(rows)[p].employerCount}"`));assert(html.includes('/resources/category/'+CATEGORIES[slug].resourceCategory+'/'));assert.equal((html.match(/<h1[ >]/g)||[]).length,1);assert(html.includes(`data-job-count="${count}"`));assert(html.includes(`data-page-count="${Math.min(PAGE_SIZE,count)}"`));assert.equal((html.match(/<article class="seo-card">/g)||[]).length,Math.min(PAGE_SIZE,count));
   const title=html.match(/<title>(.*?)<\/title>/)[1],desc=html.match(/<meta name="description" content="(.*?)"/)[1];assert(!titles.has(title));assert(!descriptions.has(desc));titles.add(title);descriptions.add(desc);
   assert(html.includes('<h1>'+CATEGORIES[slug].label.replace('&','&amp;')+(florida?' in Florida':'')+'</h1>'));
   const schema=JSON.parse(html.match(/type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);assert.equal(schema['@graph'][0]['@type'],'CollectionPage');assert.equal(schema['@graph'][0].url,PUBLIC+p);assert.equal(schema['@graph'][1]['@type'],'BreadcrumbList');schema['@graph'][1].itemListElement.forEach((item,i)=>{assert.equal(item.position,i+1);assert(html.includes(item.item));});
   if(count>PAGE_SIZE){const second=await (await get(p+'?page=2')).text();assert(second.includes(`href="${PUBLIC+p}?page=2"`));assert(second.includes('Showing 31–60 of 65'));const firstLinks=[...html.matchAll(/class="seo-detail" href="(\/jobs\/[a-f0-9-]{36})"/g)].map(x=>x[1]);assert(!firstLinks.some(u=>second.includes('href="'+u+'"')));const third=await(await get(p+'?page=3')).text();assert.equal((third.match(/<article class="seo-card">/g)||[]).length,5);assert(!third.includes('>Next page<'));}
   for(const filter of ['?zip=33101','?sort=salary','?page=2&radius=50']){const response=await get(p+filter);if(response.status===200)assert((await response.text()).includes('content="noindex, follow"'));}
   const tracked=await(await get(p+'?utm_source=google')).text();assert.equal(tracked.includes('content="noindex'),!buildCollections(rows)[p].qualified);assert(tracked.includes(`href="${PUBLIC+p}"`));
  }
  for(const p of ['/jobs/category/no-such-category','/jobs/category/medical-sales-jobs/florida/orlando','/jobs/category/medical-sales-jobs/texas','/jobs/category/veterinary-sales-jobs/florida','/not-a-rook-page','/jobs/category/medical-sales-jobs?page=0','/jobs/category/medical-sales-jobs?page=999'])assert.equal((await get(p)).status,404,p);
  const alias=await get('/jobs/category/animal-health-sales-jobs');assert.equal(alias.status,301);assert.equal(alias.headers.get('location'),'/jobs/category/veterinary-sales-jobs');
  const home=await get('/index.html?utm_source=test');assert.equal(home.status,301);assert.equal(home.headers.get('location'),'/?utm_source=test');
  for(const file of ['rook-dashboard-v7.html','rook-dashboard.html','rook-onboarding-v7-signup.html','rook-checkout-v7.html','rook-login.html','rook-search.html']){const r=await get('/'+file);assert.equal(r.status,200,file);assert.equal(r.headers.get('x-robots-tag'),'noindex, follow');}
  for(const file of ['rook-onboarding.html',...[2,3,4,5,6,7].map(v=>`rook-onboarding-v${v}.html`)]){
    const r=await get('/'+file+'?utm_source=google&gclid=test%2Bvalue');
    assert.equal(r.status,302,file);
    assert.equal(r.headers.get('location'),'/rook-onboarding-v8.html?utm_source=google&gclid=test%2Bvalue',file);
  }
  for(const [from,to] of [['/rook-onboarding-v2.html?ob=resume_upload','/rook-resume.html?ob=resume_upload&rook_v8=1'],['/rook-onboarding-v2.html?edit=preferences','/rook-settings.html?edit=preferences&rook_v8=1']]){
    const r=await get(from);assert.equal(r.status,302);assert.equal(r.headers.get('location'),to);
  }
  const ad=await get('/medical-sales/free-trial?utm_source=google');assert.equal(ad.status,302);assert.equal(ad.headers.get('location'),'/rook-onboarding-v8.html?utm_source=google');
  for(const file of ['','rook-browse.html','rook-about.html','rook-employers.html','rook-companies.html']){const r=await get('/'+file);assert.equal(r.status,200);assert((await r.text()).includes(`rel="canonical" href="${PUBLIC}/${file}"`));}
  const map=await(await get('/sitemap.xml')).text();for(const slug of Object.keys(CATEGORIES)){assert.equal(map.includes(PUBLIC+'/jobs/category/'+slug+'</loc>'),buildCollections(rows)['/jobs/category/'+slug].qualified);if(FLORIDA.includes(slug))assert(map.includes(PUBLIC+'/jobs/category/'+slug+'/florida</loc>'));}assert(!map.includes('/animal-health-sales-jobs'));assert(map.includes('/jobs/'+rows[0].id));noSecrets(map);
  for(const p of ['/jobs/'+rows[0].id,'/api/jobs/'+rows[0].id]){if(p.startsWith('/api'))continue;const r=await get(p);assert.equal(r.status,200);noSecrets(await r.text());}
  assert.equal((await get('/jobs/00000000-0000-0000-0000-000000000000')).status,404);
  fail=true;assert.equal((await get('/jobs/'+rows[0].id)).status,503);fail=false;
  const robots=await(await get('/robots.txt')).text();assert(!robots.includes('Disallow: /rook-dashboard'));assert(robots.includes('Sitemap:'));
 }finally{server.close();server.closeAllConnections();}
});
test('thin Florida inventory remains usable but noindexed and not promoted',async()=>{
 const {createCollectionHandler}=require('./seoCollections');const source=Array.from({length:25},(_,i)=>({...job(i),employer_id:'one',company_name:'one'}));const c=buildCollections(source);assert(!c['/jobs/category/medical-sales-jobs/florida'].qualified);
 let rendered;const handler=createCollectionHandler({loadInventory:async()=>c,pageShell:v=>{rendered=v;return 'ok';},escapeHtml:s=>s,baseUrl:PUBLIC});await handler({params:{slug:'medical-sales-jobs',state:'florida'},query:{}},{send(){}});assert.equal(rendered.noindex,true);assert(!rendered.bodyHtml.includes('aria-label="Florida categories"'));
});

test('existing role collections count matching eligible jobs and employers, not all employers',()=>{
 const t=job(700);t.title_original='Territory Sales Manager - Surgical';
 const k=job(701);k.title_original='Key Account Manager, Diagnostics';
 const unrelated=job(702);unrelated.title_original='Field Sales Representative';
 const pending={...job(703),title_original:t.title_original,moderation_status:'pending'};
 const inactive={...job(704),title_original:k.title_original,status:'expired'};
 const unclassified={...job(705,[]),title_original:k.title_original};
 const c=buildCollections([t,k,unrelated,pending,inactive,unclassified]);
 for(const slug of ['territory-sales-manager-jobs','key-account-manager-jobs']){
   assert.equal(c['/jobs/category/'+slug].count,1);assert.equal(c['/jobs/category/'+slug].employerCount,1);
 }
});
test('pharmaceutical collection uses classified active inventory and distinct matching employers',()=>{
 const a=job(800,['Pharmaceutical']), b=job(801,['Pharmaceutical']), duplicate={...a,id:job(802).id};
 const unrelated=job(803,['Medical Device']);
 const c=buildCollections([a,b,duplicate,unrelated,{...job(804,['Pharmaceutical']),status:'expired'},{...job(805,['Pharmaceutical']),moderation_status:'pending'}])['/jobs/category/pharmaceutical-sales-jobs'];
 assert.equal(c.count,2);assert.equal(c.employerCount,2);
});

test('resource links include only valid published results and reuse a short cache',async()=>{
 const {createRelatedArticleLoader}=require('./seoCollections');let calls=0;const filters=[];
 const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},lte(k){filters.push([k]);return q;},order(){return q;},limit(n){assert.equal(n,2);return q;},then(resolve){calls++;return Promise.resolve({data:[{slug:'medical-sales-resume',title:'Resume guide'},{slug:'../private',title:'Bad'}]}).then(resolve);}};
 const load=createRelatedArticleLoader({from:()=>q});assert.deepEqual(await load('medical-device'),[{slug:'medical-sales-resume',title:'Resume guide'}]);await load('medical-device');assert.equal(calls,1);assert(filters.some(([k,v])=>k==='resource_topics.status'&&v==='published'));assert(filters.some(([k])=>k==='published_at'));
 assert.deepEqual(await createRelatedArticleLoader({from(){throw Error('offline');}})('medical-device'),[]);
});
