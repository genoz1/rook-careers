const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {parseCareersPage,fetchCustomHtmlJobs,normalizeCustomHtmlJob,classify} = require('./adapters/customHtml');
const {titleLooksRelevant} = require('./relevanceFilter');
const {validateJobLocation} = require('./validateJobLocation');
const {isUsEligibleJob} = require('./jobEligibility');
const {prepareJob} = require('./v7Location');
const fixture = name => fs.readFileSync(path.join(__dirname,'fixtures/customHtml',name+'.html'),'utf8');
const url = 'https://employer.example/careers';
const employer = {id:'test',company_name:'Employer',company_website:'https://employer.example',careers_url:url,ats_type:'custom_html'};
const detail = 'Sell veterinary diagnostic products to clinics in the assigned territory. Develop customer relationships and meet sales goals. Qualifications: three years of sales experience.';
const section = (title,body) => `<h2>${title}</h2><p>${detail}</p>${body}`;
const fetchHtml = html => fetchCustomHtmlJobs(employer,{fetchPage:async()=>html,now:new Date('2026-09-18')});

test('Bionote: two isolated sections; current sales versus future regulatory; eight territory groups, one row',async()=>{
 const raw=parseCareersPage(fixture('bionote'),'https://www.bionote.com/careers').jobs;
 assert.equal(raw.length,2); assert.equal(raw[0].status,'current'); assert.equal(raw[1].status,'future');
 assert.equal(raw[0].locations.length,8); assert(!raw[0].html.includes('Bilingual Regulatory'));
 const row=normalizeCustomHtmlJob(raw[0],{...employer,careers_url:'https://www.bionote.com/careers'});
 assert.equal(row.status,'active'); assert.equal(row.application_url,'mailto:info@bionote.com');
 assert.equal(row.extraction_evidence.territories.length,8);
 assert.deepEqual(row.extraction_evidence.territories[2].states,['MN','ND','SD','IA']);
 assert.deepEqual(row.extraction_evidence.territories[7].states,['FL']);
 const refreshed={...row,...await validateJobLocation(row,()=>{throw Error('must not geocode territory centroid');})};
 assert.equal(refreshed.job_lat,null); assert(isUsEligibleJob(refreshed));
 // Eight named regional territories are not a nationwide posting; the
 // split source rows below retain the correct state-specific matches.
 assert.equal(prepareJob(refreshed,{territory_size_preferences:['national']}),null);
 assert.equal(prepareJob(refreshed,{territory_size_preferences:['local']}),null);
 assert.equal(normalizeCustomHtmlJob(raw[1],{...employer,careers_url:'https://www.bionote.com/careers'}).status,'closed');
});
test('Aurora: three bounded accordion jobs, only one relevant sales title; no headquarters leakage',()=>{
 const raw=parseCareersPage(fixture('aurora'),url).jobs;
 assert.equal(raw.length,3); const sales=raw.filter(j=>titleLooksRelevant(j.title));assert.equal(sales.length,1);
 assert.equal(sales[0].title,'Animal Health Manufacturer Sales Representative');
 assert.equal(sales[0].status,'likely_current');assert.deepEqual(sales[0].locations,['Field-Based']);
 assert(!sales[0].html.includes('Production Technician'));assert(!sales[0].html.includes('Engineering Manager'));
 assert.equal(sales[0].applications[0],url+'#submit-resume');
});
test('PetVivo: listing links to a detail page; current broken destination aborts snapshot',async()=>{
 const parsed=parseCareersPage(fixture('petvivo'),url);assert.equal(parsed.jobs.length,0);assert.equal(parsed.detailLinks.length,1);
 await assert.rejects(fetchCustomHtmlJobs(employer,{fetchPage:async target=>{if(target===url)return fixture('petvivo');throw Error('HTTP 404');}}),/404/);
});
test('Torigen: legacy fixture extracts Indeed destination, but unverified host cannot activate it',()=>{
 const raw=parseCareersPage(fixture('torigen-legacy'),'https://conor-odonoghue-83km.squarespace.com/careers').jobs;
 assert.equal(raw.length,1);assert.equal(raw[0].title,'Inside Sales Consultant');assert.equal(raw[0].status,'likely_current');
 const row=normalizeCustomHtmlJob(raw[0],{...employer,company_website:'https://www.torigen.com',careers_url:'https://www.torigen.com/careers'});
 assert.equal(row.source_verified,false);assert.equal(row.status,'closed');assert.match(row.application_url,/indeed.com/);
});
test('static sibling jobs stop at same-level unrelated headings; footer/navigation cannot become jobs',async()=>{
 const raw=await fetchHtml(`<nav>${section('Sales Manager','Apply')}</nav><main>${section('Sales Representative','<a href="mailto:hr@example.com">Apply</a>')}<h2>Benefits</h2><p>Future opportunities are listed separately.</p>${section('Regulatory Affairs Liaison','<p>Future opportunities only</p>')}</main><footer>Sales Director Apply</footer>`);
 assert.equal(raw.length,2); assert.equal(raw[0].status,'likely_current');assert(!raw[0].html.includes('Future opportunities'));
 assert.equal(raw[1].status,'future');
});
test('current, closed, future, expired and unknown stay distinct',()=>{
 assert.equal(classify('We are currently hiring sales representatives'),'current');
 assert.equal(classify('This position has been filled. Apply now'),'closed');
 assert.equal(classify('No open positions; future opportunities only'),'future');
 assert.equal(classify('Apply now',{validThrough:'2020-01-01'}),'closed');
 assert.equal(classify('Apply now',{datePosted:'2099-01-01'}),'future');
 assert.equal(classify(detail),'unknown');
});
test('JSON-LD graph/arrays preserve description, applications, multiple locations and expiry',async()=>{
 const j={'@type':'JobPosting',title:'Sales Representative',description:detail,url:'https://forms.office.com/example',jobLocation:[{address:{addressLocality:'Boston',addressRegion:'MA',addressCountry:'US'}},{address:{addressLocality:'Dallas',addressRegion:'TX',addressCountry:'US'}}],validThrough:'2027-01-01'};
 const raw=await fetchHtml(`<script type="application/ld+json">${JSON.stringify({'@graph':[j]})}</script>`);
 assert.equal(raw.length,1);assert.equal(raw[0].tier,'json_ld');assert.equal(raw[0].locations.length,2);
 const row=normalizeCustomHtmlJob(raw[0],employer);assert.equal(row.source_verified,true);assert.equal(row.status,'active');assert.equal(row.application_url,j.url);
 const expired=await fetchHtml(`<script type="application/ld+json">${JSON.stringify([{...j,validThrough:'2020-01-01'}])}</script>`);assert.equal(normalizeCustomHtmlJob(expired[0],employer).status,'closed');
});
test('visible closure beats stale JSON-LD and the same role appears only once',async()=>{
 const j={'@type':'JobPosting',title:'Sales Representative',description:detail};
 const raw=await fetchHtml(`<script type="application/ld+json">${JSON.stringify(j)}</script>${section(j.title,'This position has been filled')}`);
 assert.equal(raw.length,1);assert.equal(raw[0].status,'closed');
});
test('distinct job-link tier fetches each URL once and retains individual jobs',async()=>{
 const pages={[url]:'<a href="/job-a">Sales Representative</a><a href="/job-a">Apply Here</a><a href="/job-b">Territory Manager</a>', 'https://employer.example/job-a':section('Sales Representative','Apply now'), 'https://employer.example/job-b':section('Territory Manager','Apply now')};
 const calls=[];const raw=await fetchCustomHtmlJobs(employer,{fetchPage:async target=>{calls.push(target);return pages[target];}});
 assert.equal(raw.length,2);assert.equal(calls.length,3);assert(raw.every(j=>j.tier==='job_link'));
});
test('one multi-territory job does not fan out; content edits do not change source ID',async()=>{
 const body=section('Sales Representative','<p>Following territories:</p><ul><li>Florida</li><li>Georgia</li></ul><a href="https://forms.gle/example">Apply now</a>');
 const first=normalizeCustomHtmlJob((await fetchHtml(body))[0],employer);
 const next=normalizeCustomHtmlJob((await fetchHtml(body.replace('Georgia','Texas')))[0],employer);
 assert.equal(first.source_job_id,next.source_job_id);assert.notEqual(first.extraction_evidence.content_hash,next.extraction_evidence.content_hash);
 assert.equal(first.source_verified,true);assert.match(first.application_url,/forms.gle/);
});
test('empty, blocked and malformed pages cannot trigger successful disappearance closures',async()=>{
 for(const html of ['<h1>Verify you are human</h1>','<div id="app"></div>','<script type="application/ld+json">bad json</script>']) await assert.rejects(fetchHtml(html),/No recognizable/);
 assert.deepEqual(await fetchHtml('<main>No current openings</main>'),[]);
});
test('existing ATS normalizers retain their contracts',()=>{
 for(const [moduleName,fn,raw] of [
  ['greenhouse','normalizeGreenhouseJob',{id:1,title:'Sales Representative',content:detail,absolute_url:'https://boards.greenhouse.io/example/1',location:{name:'Boston, MA'}}],
  ['lever','normalizeLeverJob',{id:'2',text:'Sales Representative',description:detail,hostedUrl:'https://jobs.lever.co/example/2',applyUrl:'https://jobs.lever.co/example/2/apply',categories:{location:'Dallas, TX'}}],
  ['ashby','normalizeAshbyJob',{id:'3',title:'Sales Representative',descriptionHtml:detail,jobUrl:'https://jobs.ashbyhq.com/example/3',applyUrl:'https://jobs.ashbyhq.com/example/3/application',location:'Boston, MA'}]
 ]){const row=require('./adapters/'+moduleName)[fn](raw,employer);assert.equal(row.status,'active');assert.equal(row.source_type,moduleName);assert.equal(row.source_verified,true);assert.equal(row.title_original,'Sales Representative');}
});

test('ingestion dispatcher: custom current/future rows, failed fetch safety and unchanged ATS path',async()=>{
 const vm=require('node:vm');
 async function run(type,{failure=false,sharedParent=false,env={CUSTOM_HTML_EMPLOYER_IDS:'test'},id='test'}={}){
  const writes=[],calls=[];
  const db={from(table){const q={table,op:'select',values:null,filters:[],select(){return q;},eq(k,v){q.filters.push([k,v]);return q;},not(){q.analysis=true;return q;},order(){return q;},range(){return q;},update(v){q.op='update';q.values=v;return q;},upsert(v){q.op='upsert';q.values=v;return q;},in(k,v){q.filters.push([k,v]);return q;},single(){return Promise.resolve({data:{...q.values,id:'new',ai_analysis:{sales_motion:['sales']},job_embedding:[1]},error:null}).then(r=>{writes.push({...q});return r;});},then(resolve,reject){if(q.op!=='select')writes.push({...q});return Promise.resolve({data:sharedParent && q.analysis ? [{source_job_id:'parent',title_original:'Sales Representative',description_text:detail,ai_analysis:{product_categories:['veterinary diagnostics']},job_embedding:[0.5]}] : [],error:null}).then(resolve,reject);}};return q;}};
  const custom=require('./adapters/customHtml');
  const localRequire=name=>{
   if(name==='dotenv')return {config(){}};
   if(name==='./socialAutomation')return {safeEvaluateSocialEligibilityForIngestion:()=>false};
   if(name==='./matching')return {mentionsNonUsCountry:()=>false};
   if(name==='@supabase/supabase-js')return {createClient:()=>db};
   if(name==='./adapters/customHtml')return {...custom,fetchCustomHtmlJobs:async()=>{calls.push('custom');if(failure)throw Error('HTTP 404');return [
    {title:'Sales Representative',html:detail,locations:[],url,tier:'static_section',confidence:'high',status:'current',applications:[url]},
    {title:'Territory Manager',html:detail,locations:[],url,tier:'static_section',confidence:'high',status:'future',applications:[url]}
   ];}};
   if(name==='./adapters/greenhouse')return {...require(name.replace('./','./')),fetchGreenhouseJobs:async()=>{calls.push('greenhouse');return [{id:1,title:'Sales Representative',content:detail,absolute_url:url,location:{name:'Boston, MA'}}];}};
   if(name==='./validateJobLocation')return {validateJobLocation:async()=>({location_evidence:{status:'unresolved'}})};
   if(name==='./ai/jobAnalysis')return {analyzeJob:async()=>{throw Error('Unexpected paid analysis');}};
   if(name==='./ai/embeddings')return {generateEmbedding:async()=>{throw Error('Unexpected paid embedding');}};
   return require(name);
  };
  const context={require:localRequire,module:{exports:{}},console:{log(){},error(){}},process:{env,argv:[]},Set,Map,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'ingest.js'),'utf8'),context);
  await context.module.exports.ingestEmployer({...employer,id,ats_type:type});return {writes,calls};
 }
 const scheduled=await run('custom_html',{env:{},id:'83ada8b6-a0a0-4c62-8384-d507015275cb'});assert.deepEqual(scheduled.calls,['custom']);
 assert.deepEqual((await run('custom_html',{env:{}})).calls,[]);
 assert.deepEqual((await run('custom_html',{env:{CUSTOM_HTML_EMPLOYER_IDS:''},id:'83ada8b6-a0a0-4c62-8384-d507015275cb'})).calls,[]);
 const custom=await run('custom_html');assert.deepEqual(custom.calls,['custom']);
 const saved=custom.writes.filter(q=>q.op==='upsert');assert.equal(saved.length,2);assert.equal(saved[0].values.status,'active');assert.equal(saved[1].values.status,'closed');
 const reused=await run('custom_html',{sharedParent:true});
 assert.deepEqual(reused.writes.find(q=>q.op==='upsert').values.ai_analysis,{product_categories:['veterinary diagnostics']});
 assert.deepEqual(reused.writes.find(q=>q.op==='upsert').values.job_embedding,[0.5]);
 const failed=await run('custom_html',{failure:true});assert(!failed.writes.some(q=>q.table==='jobs'));assert.equal(failed.writes[0].values.sync_status,'error');
 const ats=await run('greenhouse');assert.deepEqual(ats.calls,['greenhouse']);assert.equal(ats.writes.find(q=>q.op==='upsert').values.source_type,'greenhouse');
});
test('future-opportunity heading scopes its child role; locations and same-title distinct postings remain separate',async()=>{
 const raw=await fetchHtml(`<h2>Future opportunities</h2><h3>Sales Representative</h3><p>${detail}</p><a href="mailto:hr@example.com">Apply</a><h2>Current roles</h2>${section('Territory Manager','<p>Location: Boston, MA</p><p>Apply now</p>')}${section('Territory Manager','<p>Location: Dallas, TX</p><p>Apply now</p>')}`);
 assert.equal(raw.length,3);assert.equal(raw[0].status,'future');
 assert.deepEqual(raw[1].locations,['Boston, MA']);assert.deepEqual(raw[2].locations,['Dallas, TX']);
 assert.notEqual(normalizeCustomHtmlJob(raw[1],employer).source_job_id,normalizeCustomHtmlJob(raw[2],employer).source_job_id);
});
test('future context applies to all sibling roles and accordion sections, but resets at the next section',async()=>{
 const raw=await fetchHtml(`<h2>Future opportunities</h2><h3>Sales Representative</h3><p>${detail}</p><p>Apply now</p><h3>Territory Manager</h3><p>${detail}</p><p>Apply now</p><h2>Open Positions</h2><details><summary>Account Executive</summary><p>${detail}</p><p>Apply now</p></details>`);
 assert.equal(raw.find(j=>j.title==='Sales Representative').status,'future');
 assert.equal(raw.find(j=>j.title==='Territory Manager').status,'future');
 assert.equal(raw.find(j=>j.title==='Account Executive').status,'likely_current');
 const future=await fetchHtml(`<h2>Future opportunities</h2><details><summary>Account Executive</summary><p>${detail}</p><p>Apply now</p></details>`);
 assert.equal(future[0].status,'future');
});
test('source city, configured industry and website original link survive normalization; existing classifier handles analysis',async()=>{
 const raw=(await fetchHtml(section('Veterinary Sales Representative','<p>Location: Boston, MA</p><a href="https://forms.gle/apply">Apply now</a>')))[0];
 const row=normalizeCustomHtmlJob(raw,{...employer,industry:'Veterinary Diagnostics'});
 assert.equal(row.city,'Boston');assert.equal(row.industry,'Veterinary Diagnostics');
 assert.equal(row.source_url,url);assert.equal(row.application_url,'https://forms.gle/apply');
 const {classify:classifyIndustry}=require('../public/rook-job-classification');
 assert.deepEqual(classifyIndustry({...row,ai_analysis:{product_categories:['veterinary diagnostics']}}).labels,['Diagnostics','Veterinary']);
 assert.equal(normalizeCustomHtmlJob({...raw,locations:['Southern California']},employer).city,null);
 assert.equal(normalizeCustomHtmlJob({...raw,locations:['Boston, MA','Dallas, TX']},employer).city,null);
 const dashboard=fs.readFileSync(path.join(__dirname,'../public/rook-dashboard-v7.html'),'utf8');
 assert(dashboard.includes('href="${job.source_url || \'#\'}" target="_blank" class="btn btn-outline btn-sm">View Original'));
});
test('opt-in territory split produces eight stable distinct listings with the same source and description',()=>{
 const {splitTerritoryOpenings}=require('./adapters/customHtml');
 const raw=parseCareersPage(fixture('bionote'),'https://www.bionote.com/careers').jobs;
 const children=splitTerritoryOpenings(raw);
 const sales=children.filter(j=>titleLooksRelevant(j.title));assert.equal(sales.length,8);
 const rows=sales.map(j=>normalizeCustomHtmlJob(j,{...employer,careers_url:j.url}));
 assert.equal(new Set(rows.map(j=>j.source_job_id)).size,8);
 assert(rows.every(j=>j.location_raw && !j.location_raw.includes('|')));
 assert(rows.every(j=>j.city===null && j.extraction_evidence.original_title==='Diagnostic Sales Specialist (DSS)'));
 assert(rows.every(j=>j.source_url==='https://www.bionote.com/careers' && j.description_text===rows[0].description_text));
 const reverse=splitTerritoryOpenings([{...raw[0],locations:[...raw[0].locations].reverse()}]).map(j=>normalizeCustomHtmlJob(j,employer).source_job_id).sort();
 assert.deepEqual(reverse,rows.map(j=>j.source_job_id).sort());
});


test('34484 radius includes verified Florida territory without invented coordinates',()=>{
 const {splitTerritoryOpenings} = require('./adapters/customHtml');
 const {matchesState,territories,withinRadius} = require('../public/rook-territory-location');
 const {redactForNonSubscriber} = require('./redaction');
 const zip = require('zipcodes').lookup('34484');
 const profile = {home_lat:zip.latitude,home_lng:zip.longitude,home_state:'Florida',territory_size_preferences:['local']};
 const raw = parseCareersPage(fixture('bionote'),'https://www.bionote.com/careers').jobs;
 const rows = splitTerritoryOpenings(raw).map(r=>normalizeCustomHtmlJob(r,{...employer,careers_url:'https://www.bionote.com/careers'})).filter(r=>r.status==='active');
 assert.equal(rows.length,8);
 const found = rows.filter(r=>prepareJob(r,profile));
 assert.equal(found.length,1); assert.equal(found[0].location_raw,'Central/Northern Florida');
 assert.equal(prepareJob(found[0],profile).job_lat,null); assert.equal(found[0].city,null);
 assert(matchesState(found[0],'FL')); assert(!matchesState(found[0],'CA'));
 const masked = redactForNonSubscriber(found[0]);
 // Pretrial projection intentionally hides the exact territory and source
 // contact details; the full subscriber row still supports state matching.
 assert(!masked.extraction_evidence); assert(!JSON.stringify(masked).includes('mailto:'));
 assert.deepEqual(territories(masked),[]);
 assert.deepEqual(territories(found[0]),[{label:'Central/Northern Florida',scope:'state_or_region',states:['FL']}]);
 // Execute the real radius-filter block for the reported 100-mile search.
 const page = fs.readFileSync(path.join(__dirname,'../public/rook-search.html'),'utf8');
 const start = page.indexOf("      const radiusMiles = Number(document.getElementById('radiusSelect').value);");
 const end = page.indexOf('      return true;',start);
 const filter = new Function('job','nearLocationCoords','document','RookTerritoryLocation','distanceMilesClient',page.slice(start,end)+'return true;');
 const run = (job,dist=0)=>filter(job,{lat:zip.latitude,lng:zip.longitude,stateAbbr:'FL'},{getElementById:()=>({value:'100'})},{matchesState,withinRadius},()=>dist);
 // Unverified state overlap alone cannot pass. The API's actual polygon
 // containment decision can pass without creating any point or mileage.
 const searched = require('./searchDistance').attachSearchDistance(found[0],profile);
 assert(run(searched)); assert.equal(searched.job_lat,null); assert.equal(searched.distance_miles,null);
 assert(!run(found[0])); assert(!run(rows[0])); assert(!run({job_lat:null,job_lng:null}));
 assert(run({job_lat:28,job_lng:-82},99)); assert(!run({job_lat:28,job_lng:-82},101));
});
