const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {COMPANIES,buildCompanies,createCompanyLoader,createCompanyHandlers,searchUrl}=require('./companySeo');
const job=(i,name='Abbott')=>({id:`22222222-2222-4222-8222-${String(i).padStart(12,'0')}`,company_name:name,employer_id:name,source_job_id:String(i),source_url:'https://jobs.example/'+i,title_original:'SecretBrand Sales Representative',title_normalized:'Sales Representative',description_text:'Private description',location_raw:'Tampa, FL, United States',city:'Tampa',state:'FL',job_lat:27.95,job_lng:-82.46,status:'active',moderation_status:'approved',ai_analysis:{product_categories:['Medical Device']},date_posted:'2026-09-01'});
test('ten supplied employers only; counts follow eligible exact identities and deduplication',()=>{
 assert.equal(Object.keys(COMPANIES).length,10);
 const a=job(1),duplicate={...a,id:job(2).id};
 const c=buildCompanies([a,duplicate,job(3,'abbott'),job(4,'Abbott Laboratories Other'),{...job(5),status:'expired'},{...job(6),moderation_status:'pending'},{...job(7),location_raw:'Paris, France',location_evidence:{status:'foreign',source_country_code:'FR'}},job(8,'Medtronic')]);
 assert.equal(c.abbott.count,2);assert.equal(c.medtronic.count,1);assert.equal(c.gsk.count,0);assert.equal(c.abbott.qualified,false);
 assert(!JSON.stringify(c).includes('SecretBrand'));assert(!JSON.stringify(c).includes('Private description'));
});
test('directory and ten reusable pages: names, counts, logos, links, schema, metadata and stable zero routes',async()=>{
 const rows=Object.values(COMPANIES).flatMap((c,n)=>Array.from({length:n===9?0:n===8?3:21+n},(_,i)=>job(1000+n*100+i,c.name)));
 const companies=buildCompanies(rows);let rendered;
 const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
 const handlers=createCompanyHandlers({loadCompanies:async()=>companies,pageShell:v=>{rendered=v;return 'html';},escapeHtml:esc,baseUrl:'https://rookcareers.com'});
 const res={send(){},status(n){this.code=n;return this;},set(){return this;}};
 await handlers.directory({query:{}},res);assert.equal(rendered.noindex,false);assert.equal(rendered.canonicalUrl,'https://rookcareers.com/companies');assert.equal((rendered.bodyHtml.match(/<article /g)||[]).length,10);
 const actualOrder=[...rendered.bodyHtml.matchAll(/data-company="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(actualOrder,Object.values(companies).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)).map(c=>c.slug));
 const titles=new Set(),descriptions=new Set();
 for(const c of Object.values(companies)){
  await handlers.employer({params:{slug:c.slug},query:{}},res);
  assert.equal(rendered.canonicalUrl,'https://rookcareers.com/companies/'+c.slug);assert.equal(rendered.noindex,c.count<20);assert.equal(rendered.publicCompany,true);
  assert.equal((rendered.bodyHtml.match(/<h1>/g)||[]).length,1);assert(rendered.bodyHtml.includes(`data-job-count="${c.count}"`));assert(rendered.bodyHtml.includes('href="'+searchUrl(c)+'"'));
  assert(!titles.has(rendered.title));titles.add(rendered.title);assert(!descriptions.has(rendered.description));descriptions.add(rendered.description);
  const schema=rendered.jsonLd['@graph'];assert.equal(schema[0]['@type'],'CollectionPage');assert.equal(schema[1].itemListElement.length,3);assert.equal(schema[0].mainEntity.numberOfItems,Math.min(6,c.count));
  if(c.logo){assert(rendered.bodyHtml.includes('/assets/employer-logos/'+c.logo));assert(fs.statSync(path.join(__dirname,'../public/assets/employer-logos',c.logo)).size>0);}else assert(!rendered.bodyHtml.includes('<img'));
  if(!c.count)assert(rendered.bodyHtml.includes('There are no current ROOK openings'));
  assert(!rendered.bodyHtml.includes('Private description'));
 }
 await handlers.employer({params:{slug:'company-11'},query:{}},res);assert.equal(res.code,404);
 const unavailable=createCompanyHandlers({loadCompanies:async()=>{throw Error('offline');},pageShell(){},escapeHtml:esc,baseUrl:''});await unavailable.directory({query:{}},res);assert.equal(res.code,503);
});
test('shared paginated loader reads beyond response caps and does not turn failures into zero counts',async()=>{
 const rows=Array.from({length:45},(_,i)=>job(i));let calls=0,fail=false;
 const db={from(){let offset=0;const q={select(){return q;},eq(){return q;},order(){return q;},range(n){offset=n;return q;},then(resolve){calls++;return Promise.resolve({data:rows.slice(offset,offset+7),error:fail?{}:null}).then(resolve);}};return q;}};
 const load=createCompanyLoader(db,{ttl:0});assert.equal((await load()).abbott.count,45);assert(calls>=7);fail=true;await assert.rejects(load(),/unavailable/);
});
test('company handoff populates the exact company API parameter and can be cleared without modifying other filters',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/rook-search.html'),'utf8');
 assert(html.includes("new URLSearchParams(location.search).get('company')"));assert(html.includes("params.set('company', selectedCompany)"));assert(html.includes("sessionStorage.removeItem('rook_company_search')"));
 const route=fs.readFileSync(path.join(__dirname,'routes/jobs.js'),'utf8');const search=route.slice(route.indexOf('router.get("/job-search"'),route.indexOf('// GET /api/jobs?'));
 assert(search.includes('query.ilike("company_name",selectedCompany.name)'));assert(search.includes('Unknown company filter'));assert(search.indexOf('query.ilike')<search.indexOf('await readJobPool(query)'));
});
test('real company routes, legacy redirect and sitemap share indexability thresholds',async()=>{
 process.env.SUPABASE_URL='https://example.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture';
 const rows=['Abbott','Medtronic','Stryker'].flatMap((n,i)=>Array.from({length:20},(_,k)=>job(2000+i*100+k,n)));rows.push(job(2500,'GSK'));
 const db={from(table){let cols='',filters=[],offset=0,end=999;const q={select(c){cols=c;return q;},eq(k,v){filters.push(j=>j[k]===v);return q;},lte(){return q;},limit(){return q;},order(){return q;},range(a,b){offset=a;end=b;return q;},then(resolve){const data=(table==='jobs'?rows:[]).filter(j=>filters.every(f=>f(j))).slice(offset,end+1).map(j=>Object.fromEntries(cols.split(',').map(k=>[k,j[k]])));return Promise.resolve({data,error:null}).then(resolve);}};return q;}};
 require.cache[require.resolve('@supabase/supabase-js')]={exports:{createClient:()=>db}};
 require.cache[require.resolve('./routes/stripe')]={exports:{getTrialPeriodDays:()=>3}};
 const express=require('express'),app=express();app.use(require('./routes/publicPages'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 try{
  const map=await(await fetch(origin+'/sitemap.xml')).text();assert(map.includes('/companies</loc>'));assert(map.includes('/companies/abbott</loc>'));assert(!map.includes('/companies/gsk</loc>'));assert(!map.includes('/companies/viatris</loc>'));
  for(const c of Object.values(COMPANIES)){const r=await fetch(origin+'/companies/'+c.slug);assert.equal(r.status,200);const html=await r.text();assert.equal(html.includes('content="noindex'),!['abbott','medtronic','stryker'].includes(c.slug));assert(!html.includes('src="/rook-access.js"'));assert.equal((html.match(/<h1>/g)||[]).length,1);}
  const legacy=await fetch(origin+'/rook-companies.html',{redirect:'manual'});assert.equal(legacy.status,301);assert.equal(legacy.headers.get('location'),'/companies');
  assert.equal((await fetch(origin+'/companies/company-11')).status,404);
 }finally{server.close();server.closeAllConnections();}
});
test('URL and stored company intent survive the access boundary; clearing removes both',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/rook-search.html'),'utf8');const start=html.indexOf('  let selectedCompany =');const stop=html.indexOf('  (async () => {',start);const source=html.slice(start,stop);
 for(const [url,saved,want] of [['https://rookcareers.com/rook-search.html?company=Johnson%20%26%20Johnson','Abbott','Johnson & Johnson'],['https://rookcareers.com/rook-search.html','Abbott','Abbott']]){
  const stored=new Map([['rook_company_search',saved]]);let removed=false,changed;
  const context=vm.createContext({URL,URLSearchParams,location:{href:url,search:new URL(url).search},history:{replaceState(a,b,value){changed=value;}},document:{getElementById(){return {remove(){removed=true;}};}},sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)}});
  vm.runInContext(source,context);assert.equal(vm.runInContext('selectedCompany',context),want);assert.equal(stored.get('rook_company_search'),want);
  vm.runInContext('clearSelectedCompany()',context);assert.equal(vm.runInContext('selectedCompany',context),'');assert.equal(stored.has('rook_company_search'),false);assert.equal(new URL(changed).searchParams.has('company'),false);assert(removed);
 }
});
