// Reviewed sales-first copy paired with the approved photographic asset library.
// Static assets are reused; company marketing makes no paid model requests.
const CATALOG = require('./socialApprovedCatalog.json');
const INSIGHTS = CATALOG.map(x => [x.id,x.headline,x.body]);
const VALUES = INSIGHTS;
const CARD_POINTS = {};
function selectEditorial(context = {}) {
 const recent = (context.recent || []).join('\n').toLowerCase();
 // Job posts already carry validated job facts and their own existing graphic.
 if (context.category) {
  const body = 'Explore this sales opportunity on ROOK, a focused destination for medical and veterinary sales jobs. Review the complete job details before applying.';
  return {linkedin:body,facebook:body,reddit:body,text:body,fallback:false,model:null};
 }
 const day = Math.floor(Date.parse(`${context.dateStr || new Date().toISOString().slice(0,10)}T12:00:00Z`) / 86400000);
 const offset = {education:0,industry:1,value:2,engagement:3}[context.theme] || 0;
 // Interleave the five subjects before moving to the next caption variant.
 const pool = [...CATALOG].sort((a,b)=>Number(a.id.slice(-1))-Number(b.id.slice(-1)) || a.graphicId.localeCompare(b.graphicId));
 for(let i=0;i<pool.length;i++) {
  const entry=pool[(day*4 + offset + i) % pool.length];
  if(recent.includes(entry.body.toLowerCase())) continue;
  return {topicId:entry.id,graphicId:entry.graphicId,headline:entry.headline,label:'MEDICAL & VETERINARY SALES',kind:'value',points:[],
   linkedin:entry.body,facebook:entry.body,reddit:entry.body,text:entry.body,fallback:false,model:null};
 }
 throw Error('Editorial topics exhausted in recent history; defer instead of repeating');
}
module.exports = {INSIGHTS,VALUES,CARD_POINTS,selectEditorial};
