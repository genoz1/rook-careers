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
// Existing role pages use the same inventory boundary as industry pages.
CATEGORIES['territory-sales-manager-jobs'] = {
  label:'Territory Sales Manager Jobs', labels:[], rolePattern:/\bterritory[ -]+sales[ -]+manager\b/i,
  intro:'Territory sales managers develop accounts and manage sales activity within an assigned geography. Compare current opportunities across medical and animal health markets; territory size, travel and account responsibilities vary by employer.'
};
CATEGORIES['key-account-manager-jobs'] = {
  label:'Key Account Manager Jobs', labels:[], rolePattern:/\bkey[ -]+account[ -]+manager\b/i,
  intro:'Key account managers manage strategic customer relationships and account growth. Healthcare and animal health roles may involve multi-site customers, contracting and coordination with field teams. Review each listing for its customer scope and requirements.'
};
const GUIDANCE = {
  'medical-sales-jobs':['Territory representatives, account managers and sales specialists may work across the medical product and service categories in this collection.','career-advice'],
  'medical-device-sales-jobs':['Common roles include associate sales representative, territory manager and clinical sales specialist. Responsibilities may combine account development, product demonstrations and clinical support.','medical-device'],
  'pharmaceutical-sales-jobs':['Common titles include pharmaceutical sales representative, specialty sales representative and account manager. The customer group and therapeutic area depend on the listing.','pharmaceutical-biotech'],
  'diagnostics-sales-jobs':['Common roles include laboratory account executive, diagnostics sales specialist and territory manager. Products and services can include laboratory testing, diagnostic instruments and testing supplies.','diagnostics-laboratory'],
  'veterinary-sales-jobs':['Common roles include animal health territory representative, veterinary account manager and equipment sales specialist. Customers may include veterinary practices and animal health organizations.','veterinary-animal-health'],
  'capital-equipment-sales-jobs':['Common roles include equipment sales specialist, territory manager and account executive. Responsibilities may include demonstrations, evaluations and coordination with procurement and service teams.','medical-device'],
  'territory-sales-manager-jobs':['This collection matches territory sales manager titles, rather than listing every field sales opening. Compare travel, account development and territory ownership in the full listing.','career-advice'],
  'key-account-manager-jobs':['This collection matches key account manager titles, rather than every account management role. Compare the named account responsibilities and contracting requirements in the full listing.','career-advice']
};
for(const [slug,[roles,resourceCategory]] of Object.entries(GUIDANCE)) Object.assign(CATEGORIES[slug],{roles,resourceCategory});
const FLORIDA = ['medical-sales-jobs','medical-device-sales-jobs','pharmaceutical-sales-jobs','diagnostics-sales-jobs'];
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
      const matching=group.filter(job=>{const labels=labelsFor(job); return (!category.human||!labels.includes('Veterinary')) && (category.rolePattern ? labels.length>0 && category.rolePattern.test(job.title_original || job.title_normalized || '') : labels.some(l=>category.labels.includes(l))) && (!florida||floridaFor(job));});
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
    collections[path]={slug,path,florida,label:category.label+(florida?' in Florida':''),intro:category.intro,roles:category.roles,resourceCategory:category.resourceCategory,entries,count:entries.length,employerCount:employers.size,
      qualified:entries.length>=20&&employers.size>=3};
  }
  return collections;
}
// The short server-only cache exposes allowlisted projection getters and counts.
// Public previews are evaluated only for displayed cards, once per source row.
// Source rows remain private in the loader closure; never serialize raw records.
function createInventoryLoader(db,{ttl=60000,build=buildCollections}={}) {
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
      cached=build(rows);expires=Date.now()+ttl;return cached;
    })();
    try{return await pending;}finally{pending=null;}
  };
}
module.exports={CATEGORIES,FLORIDA,floridaKind,deduplicate,buildCollections,createInventoryLoader};
