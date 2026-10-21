'use strict';
const {validateSnapshot}=require('../hiringIntelligence');
const {evergreen}=require('./recoveryPilot');
const {digest,escape}=require('./security');
const ORIGIN='https://rookcareers.com';
const FAMILY=[
 ['medical-sales','Medical Sales Hiring Report',['medical-sales-jobs','medical-device-sales-jobs','pharmaceutical-sales-jobs','diagnostics-sales-jobs']],
 ['medical-device-sales','Medical Device Sales Hiring Snapshot',['medical-device-sales-jobs','capital-equipment-sales-jobs']],
 ['florida-medical-sales','Florida Medical Sales Employment Snapshot',['medical-sales-jobs/florida','medical-device-sales-jobs/florida','pharmaceutical-sales-jobs/florida','diagnostics-sales-jobs/florida']],
 ['veterinary-sales','Veterinary and Animal Health Sales Hiring Snapshot',['veterinary-sales-jobs']],
];
const {CATEGORIES}=require('../seoInventory');
function validateFresh(snapshot,now=Date.now()){
 validateSnapshot(snapshot);const age=now-Date.parse(snapshot.capturedAt);if(age<0||age>86400000)throw Error('Snapshot is not current');return snapshot;
}
function reports(snapshot,now=Date.now()){
 validateFresh(snapshot,now);
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(snapshot.capturedAt));
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).formatToParts(new Date(snapshot.capturedAt)).map(p=>[p.type,p.value]));
 const month=parts.year+'-'+parts.month;
 return FAMILY.map(([id,title,paths])=>{
  const cells=paths.map(path=>snapshot.collections.find(c=>c.path==='/jobs/category/'+path)).filter(c=>c&&!c.suppressed).map(c=>({path:c.path,label:CATEGORIES[c.path.split('/')[3]].label+(c.path.endsWith('/florida')?' — Florida':''),jobs:c.jobs,employers:c.representedEmployers}));
  if(!cells.length)return null;
  const body={slug:id+'-'+month,title:title+' — '+month,observedAt:snapshot.capturedAt,date,cells,
   caveat:'ROOK’s tracked inventory is a sample, not the entire employment market. Categories overlap; counts and employer totals must not be added together. These are advertised opportunities, not confirmed hires. No growth or salary claim is made.',
   methodology:'Counts come from existing public ROOK collections, filtered by the existing active, approved, US-eligible inventory rules. Collection observations are sequential, not an atomic database snapshot. Every vacancy has not been independently revalidated for this report.',
   guidance:evergreen.find(e=>e.id==='territory-plan').text};
  return {...body,hash:digest(JSON.stringify(body))};
 }).filter(Boolean);
}
function reportHtml(r){return `<article><h1>${escape(r.title)}</h1><p>Observed ${escape(r.date)}. Point-in-time inventory.</p><table><thead><tr><th>Collection</th><th>Opportunities</th><th>Represented employers</th></tr></thead><tbody>${r.cells.map(c=>`<tr><td><a href="${escape(c.path)}">${escape(c.label)}</a></td><td>${c.jobs}</td><td>${c.employers}</td></tr>`).join('')}</tbody></table><p>${escape(r.caveat)}</p><h2>Methodology</h2><p>${escape(r.methodology)}</p><h2>Prepare for your search</h2><p>${escape(r.guidance)}</p><p><a href="/resources/how-to-build-a-30-60-90-day-territory-sales-plan/">Territory planning guide</a> · <a href="/rook-pricing.html">How ROOK membership works</a></p></article>`;}
function candidates(snapshot,now,reportRows=[]){
 const result=[];
 try{
  validateFresh(snapshot,now);
  for(const row of reportRows){const r=row.body;if(Date.parse(r.observedAt)!==Date.parse(snapshot.capturedAt))continue;const c=r.cells[0];result.push({id:r.slug,text:`${r.title}: ROOK tracked ${c.jobs.toLocaleString('en-US')} opportunities across ${c.employers.toLocaleString('en-US')} represented employers in ${c.label}, observed ${r.date}. This is tracked inventory, not the whole market or evidence of hiring growth.`,url:ORIGIN+'/hiring-reports/'+r.slug+'/',observedAt:r.observedAt,reportHash:r.hash});}
 }catch{/* evergreen reserve remains available */}
 result.push(...evergreen);
 result.push({id:'partner-program',text:'Help medical sales candidates prepare for their next move? ROOK’s referral program offers a $5 one-time commission for a verified new paying monthly subscriber. Existing customers and self-referrals do not qualify. See the rules and get your own referral link.',url:ORIGIN+'/partners/'});
 return result.map(c=>({...c,hash:digest(c.text+'\n'+c.url)}));
}
module.exports={ORIGIN,FAMILY,validateFresh,reports,reportHtml,candidates};
