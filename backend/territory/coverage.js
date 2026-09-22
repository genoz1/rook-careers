// Coverage is independent of work arrangement and point distance. No centroids.
const boundaries=require('./boundaries.json');
const {stateCodesInText,cityQueriesInText}=require('../jobLocationScope');
const stateNames=require('zipcodes').states.full;
const regionalStates={
 'New England':['CT','ME','MA','NH','RI','VT'],
 'Mid-Atlantic':['NY','NJ','PA','DE','MD','DC','VA','WV'],
 'Southeast':['AL','AR','FL','GA','KY','LA','MS','NC','SC','TN','VA','WV'],
 'Northeast':['CT','ME','MA','NH','RI','VT','NY','NJ','PA'],
 'Midwest':['IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'],
 'Southwest':['AZ','NM','OK','TX'],
 'Pacific Northwest':['OR','WA','ID'],
 'Great Lakes':['IL','IN','MI','MN','NY','OH','PA','WI'],
 'Mountain West':['AZ','CO','ID','MT','NV','NM','UT','WY']
};
const patterns=[
 [/\bsouth(?:ern)?\s+(?:texas|TX)\b/gi,'South Texas'],
 [/\bcentral\s+valley(?:\s*,?\s*(?:CA|California))?\b/gi,'Central Valley CA'],
 [/\bnorth(?:ern)?\s+(?:california|CA)\b/gi,'Northern California'],
 [/\bsouth(?:ern)?\s+(?:california|CA)\b/gi,'Southern California'],
 [/\bnorth(?:ern)?\s+(?:florida|FL)\b/gi,'North Florida'],
 [/\bcentral\s+(?:florida|FL)\b/gi,'Central Florida'],
 [/\bsouth(?:ern)?\s+(?:florida|FL)\b/gi,'South Florida'],
 [/\bnorth(?:ern)?\s+(?:nevada|NV)\b/gi,'Northern Nevada'],
 [/\bsouth(?:ern)?\s+(?:nevada|NV)\b/gi,'Southern Nevada'],
 ...Object.keys(regionalStates).map(name=>[new RegExp('\\b'+name.replace('-', '[- ]?').replace(/ /g,'\\s+')+'\\b','gi'),name])
];
function normalize(text) {
 return String(text||'').replace(/\bNorth\s*(?:and|&)\s*South\s+(Carolina|Dakota)\b/gi,'North $1 South $1')
  .replace(/\b(?:the\s+)?Dakotas\b/gi,'North Dakota South Dakota')
  .replace(/\b(central|north(?:ern)?|south(?:ern)?)\s*[/&]\s*(N\.|S\.|north(?:ern)?|south(?:ern)?|central)\s+(Florida|FL|California|CA|Nevada|NV)\b/gi,(_,a,b,s)=>`${a} ${s} / ${b==='N.'?'North':b==='S.'?'South':b} ${s}`);
}
function parseCoverage(text) {
 let rest=normalize(text), areas=[];
 // A directional city/state modifier is not a national region (Southeast Detroit).
 for(const [pattern,name] of patterns) {
  rest=rest.replace(pattern,(match,offset,whole)=>{
   const tail=whole.slice(offset+match.length);
   if(regionalStates[name] && /^\s+[A-Za-z]/.test(tail) && !/^\s+(?:region|territory|area|and|or|US|USA|United States)\b/i.test(tail))return match;
   areas.push(name);return ' ';
  });
 }
 // Remove explicit cities before extracting states: NYC is not all of New York.
 const cities=cityQueriesInText(rest);
 if(cities.length)return {areas,hasCities:true,unresolved:!areas.length};
 const states=stateCodesInText(rest).filter(code=>boundaries[code]);
 // Unrecognized substate qualifiers must not silently become an entire state.
 const remainder=Object.keys(stateNames).reduce((s,name)=>s.replace(new RegExp('\\b'+name+'\\b','gi'),' '),rest);
 const qualified=/\b(?:north(?:ern)?|south(?:ern)?|east(?:ern)?|west(?:ern)?|central|coastal|metro|greater|valley|panhandle|upstate|northeast|northwest|southeast|southwest)\b/i.test(remainder);
 if(qualified)return {areas:[],unresolved:true};
 areas.push(...states);
 return {areas:[...new Set(areas)],unresolved:false};
}
function coverageForJob(job) {
 const e=job.location_evidence,scope=e?.scope;
 const clean=s=>String(s||'').trim().replace(/\s+/g,' ');
 if(e && ((e.source_location!=null && clean(e.source_location)!==clean(job.location_raw)) || (e.source_title&&clean(e.source_title)!==clean(job.title_original)) || scope?.kind==='foreign'))return null;
 // Only explicit coverage clauses override the title; office/based-in text does not.
 const clauses=String(job.description_text||'').split(/\r?\n|(?<=[.!?])\s+/);
 for(const clause of clauses) {
  const m=/\b(?:territory includes?|assigned territory(?: includes?| covers?)?|territory (?:covers|covering)|responsible for (?:the )?territory)\s*[:–—-]?\s*(.*)/i.exec(clause);
  if(!m)continue;
  // Exclusions and unknown boundaries require review, not an expansive guess.
  if(/\b(?:except|excluding|but not|outside)\b/i.test(m[1]))return null;
  const parsed=parseCoverage(m[1]);
  if(parsed.unresolved)return null;
  if(parsed.areas.length)return {areas:parsed.areas,source:'explicit_description_territory'};
 }
 const title=clean(job.title_original);
 if(/sales|territory|account|clinical|specialist|business development/i.test(title)) {
  const part=title.match(/\(([^()]*)\)\s*$/)?.[1] || title.split(/\s+[–—-]\s+/).pop();
  const parsed=parseCoverage(part);
  if(parsed.unresolved)return null;
  if(parsed.areas.length)return {areas:parsed.areas,source:'explicit_title_territory'};
 }
 const structuredAreas=[];
 for(const group of job.extraction_evidence?.territories||[]) {
  if(group.scope!=='state_or_region')continue;
  const parsed=parseCoverage(group.label);
  if(parsed.unresolved)return null;
  structuredAreas.push(...(parsed.areas.length?parsed.areas:(group.states||[]).filter(s=>boundaries[s])));
 }
 if(structuredAreas.length)return {areas:[...new Set(structuredAreas)],source:'source_structured_territory'};
 if(scope?.kind==='territory'&&e.status==='validated') {
  const parsed=parseCoverage(job.location_raw);
  if(parsed.unresolved)return null;
  const areas=parsed.areas.length?parsed.areas:(scope.states||[]).filter(s=>boundaries[s]);
  if(areas.length)return {areas,source:scope.reason};
 }
 return null;
}
function inRing(point,ring) {
 let inside=false;const [x,y]=point;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
  const [xi,yi]=ring[i],[xj,yj]=ring[j];
  const cross=(x-xi)*(yj-yi)-(y-yi)*(xj-xi);
  if(Math.abs(cross)<1e-10&&x>=Math.min(xi,xj)&&x<=Math.max(xi,xj)&&y>=Math.min(yi,yj)&&y<=Math.max(yi,yj))return true;
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }
 return inside;
}
function contains(area,lat,lng) {
 if(![lat,lng].every(Number.isFinite))return false;
 if(regionalStates[area])return regionalStates[area].some(s=>contains(s,lat,lng));
 const geometry=boundaries[area];if(!geometry)return false;
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 return polygons.some(rings=>inRing([lng,lat],rings[0])&&!rings.slice(1).some(r=>inRing([lng,lat],r)));
}
function territoryMatch(job,profile) {
 if(![profile?.home_lat,profile?.home_lng].every(Number.isFinite))return false;
 const coverage=coverageForJob(job);
 return !!coverage?.areas.some(area=>contains(area,profile.home_lat,profile.home_lng));
}
module.exports={coverageForJob,parseCoverage,contains,territoryMatch};
