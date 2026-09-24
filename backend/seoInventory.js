// Read-only SEO view. Reuses market classification, US eligibility and stored
// validated location evidence; never writes jobs or changes matching semantics.
const {classify} = require('../public/rook-job-classification');
const {isUsEligibleJob, resolveUsStateCode} = require('./jobEligibility');
const {VERSION, validPoint, descriptionHash} = require('./jobLocationScope');
const {project,publicPreview} = require('./pretrialProjection');
const CATEGORIES = {
  'medical-sales-jobs': {label:'Medical Sales Jobs', labels:['Medical Device','Pharmaceutical','Diagnostics','Capital Equipment'], human:true,
    intro:'Explore medical sales opportunities across devices, pharmaceuticals, diagnostics and capital equipment. Compare current masked previews, then start a trial to see employers, full job details and application links.'},
  'medical-device-sales-jobs': {label:'Medical Device Sales Jobs', labels:['Medical Device'], human:true,
    intro:'Browse medical device sales opportunities, including surgical products, clinical equipment and patient-care technology. Roles can differ in clinical support, territory coverage and account responsibilities.'},
  'pharmaceutical-sales-jobs': {label:'Pharmaceutical Sales Jobs', labels:['Pharmaceutical'], human:true,
    intro:'Explore pharmaceutical sales opportunities involving medicines and therapeutic products. Review the available role and location previews; full requirements and employer details are available with a trial.'},
  'diagnostics-sales-jobs': {label:'Diagnostics & Laboratory Sales Jobs', labels:['Diagnostics'], human:true,
    intro:'Find diagnostic sales jobs and laboratory sales opportunities involving testing, laboratory services and diagnostic products. These collections cover diagnostics and lab sales together so you can compare relevant opportunities in one place.'},
  'veterinary-sales-jobs': {label:'Veterinary & Animal Health Sales Jobs', labels:['Veterinary'],
    intro:'Explore veterinary sales jobs and animal health sales opportunities in one collection. Relevant roles may serve veterinary practices or animal-health customers across diagnostics, medicines and equipment.'},
  'capital-equipment-sales-jobs': {label:'Capital Equipment Sales Jobs', labels:['Capital Equipment'], human:true,
    intro:'Browse medical capital equipment sales opportunities. These roles focus on equipment purchases and account relationships; consult the full listing during your trial for each role’s product, territory and experience requirements.'},
};
const FLORIDA = Object.keys(CATEGORIES).slice(0,4);
const clean = value => String(value || '').trim().replace(/\s+/g,' ');
function floridaKind(job) {
  const e=job.location_evidence;
  // Reject stale, unvalidated, legacy, inferred and nationwide evidence.
  if(e?.version!==VERSION || e.status!=='validated' || clean(e.source_location)!==clean(job.location_raw) || clean(e.source_title)!==clean(job.title_original)) return null;
  if(e.source_description_hash && e.source_description_hash!==descriptionHash(job.description_text)) return null;
  const s=e.scope;
  if(s?.kind==='territory' && (s.states||[]).some(state=>resolveUsStateCode(state)==='FL')) return 'territory';
  if(s?.kind==='local' && (e.locations||[]).some(p=>validPoint(p)&&resolveUsStateCode(p.state)==='FL')) return 'local';
  return null;
}
function sourceKey(value) {
  try { const u=new URL(value); if(!['http:','https:'].includes(u.protocol))return null;
    for(const key of [...u.searchParams.keys()]) if(/^(utm_|gclid$|fbclid$)/i.test(key))u.searchParams.delete(key);
    u.hash=''; u.searchParams.sort(); return u.toString();
  } catch {return null;}
}
function deduplicate(rows) {
  // Shared exact requisition/source identities only, not fuzzy title matching.
  // Merge identity groups before category/location filtering to keep counts stable.
  const parents=rows.map((_,i)=>i), keys=new Map();
  const root=i=>parents[i]===i?i:(parents[i]=root(parents[i]));
  rows.forEach((job,i)=>{
    const employer=job.employer_id || clean(job.company_name).toLowerCase();
    const identities=['id:'+job.id, ...[job.source_url,job.application_url].map(sourceKey).filter(Boolean).map(u=>'url:'+u)];
    if(employer && job.source_job_id)identities.push('req:'+employer+':'+job.source_job_id);
    for(const key of identities){if(keys.has(key))parents[root(i)]=root(keys.get(key));else keys.set(key,i);}
  });
  const groups=new Map(); rows.forEach((job,i)=>{const key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(job);});
  return [...groups.values()];
}
function buildCollections(rows) {
  const groups=deduplicate(rows.filter(j=>j.status==='active'&&j.moderation_status==='approved'&&isUsEligibleJob(j)));
  const collections={},previews=new Map(),classifications=new Map(),floridaScopes=new Map();
  const preview=job=>{if(!previews.has(job.id))previews.set(job.id,publicPreview(job));return previews.get(job.id);};
  const labelsFor=job=>{if(!classifications.has(job.id))classifications.set(job.id,classify(job).labels);return classifications.get(job.id);};
  const floridaFor=job=>{if(!floridaScopes.has(job.id))floridaScopes.set(job.id,floridaKind(job));return floridaScopes.get(job.id);};
  for(const [slug,category] of Object.entries(CATEGORIES)) for(const florida of [false,true]) {
    if(florida&&!FLORIDA.includes(slug))continue;
    const entries=[],employers=new Set();
    for(const group of groups) {
      const matching=group.filter(job=>{const labels=labelsFor(job); return (!category.human||!labels.includes('Veterinary')) && labels.some(l=>category.labels.includes(l)) && (!florida||floridaFor(job));});
      if(!matching.length)continue;
      // Prefer newest posted row, then stable ID, for deterministic pagination.
      matching.sort((a,b)=>(Date.parse(b.date_posted)||0)-(Date.parse(a.date_posted)||0)||String(a.id).localeCompare(String(b.id)));
      const job=matching[0],safe=project(job);
      if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(job.id))continue;
      const employer=job.employer_id || clean(job.company_name).toLowerCase();if(employer)employers.add(employer);
      entries.push({url:'/jobs/'+job.id,get title(){return preview(job).title;},get location(){return preview(job).location;},role:safe.role_type,labels:safe.industry_classification.labels,
        freshness:safe.freshness_label,get employment(){return preview(job).employment_type;},floridaKind:florida?floridaFor(job):null,
        sortDate:Date.parse(job.date_posted)||0});
    }
    entries.sort((a,b)=>b.sortDate-a.sortDate||a.url.localeCompare(b.url));
    entries.forEach(e=>delete e.sortDate);
    const path='/jobs/category/'+slug+(florida?'/florida':'');
    collections[path]={slug,path,florida,label:category.label+(florida?' in Florida':''),intro:category.intro,entries,count:entries.length,employerCount:employers.size,
      qualified:entries.length>=20&&employers.size>=3};
  }
  return collections;
}
// The short server-only cache exposes allowlisted projection getters and counts.
// Public previews are evaluated only for displayed cards, once per source row.
// Source rows remain private in the loader closure; never serialize raw records.
function createInventoryLoader(db,{ttl=60000}={}) {
  let cached,expires=0,pending;
  return async function load() {
    if(cached&&Date.now()<expires)return cached;
    if(pending)return pending;
    pending=(async()=>{
      const rows=[];
      for(let offset=0;;){
        const {data,error}=await db.from('jobs').select('id,employer_id,company_name,source_job_id,source_url,application_url,title_original,title_normalized,description_text,location_raw,location_evidence,job_lat,job_lng,city,state,ai_analysis,status,moderation_status,category,subcategory,sales_type,territory,remote_status,employment_type,date_posted,first_seen_at')
          .eq('status','active').eq('moderation_status','approved').order('id',{ascending:true}).range(offset,offset+499);
        if(error||!Array.isArray(data))throw new Error('SEO inventory unavailable');
        if(!data.length)break;rows.push(...data);offset+=data.length;
      }
      cached=buildCollections(rows);expires=Date.now()+ttl;return cached;
    })();
    try{return await pending;}finally{pending=null;}
  };
}
module.exports={CATEGORIES,FLORIDA,floridaKind,deduplicate,buildCollections,createInventoryLoader};
