const {distanceMiles}=require('./geocoding');
const {validPoint}=require('./jobLocationScope');
const {coverageForJob,contains}=require('./territory/coverage');

// Search is an unscored catalog: use the nearest verified location without
// applying Dashboard's radius. Remote arrangement never removes a city point.
function attachSearchDistance(job, profile) {
  const evidence=job.location_evidence;
  const sameSource=evidence?.source_location===String(job.location_raw||'').trim().replace(/\s+/g,' ');
  const coverage=[profile?.home_lat,profile?.home_lng].every(Number.isFinite) ? coverageForJob(job) : null;
  const inside=p=>coverage?.areas.some(a=>contains(a,p.lat,p.lng));
  const territoryMatch=inside({lat:profile?.home_lat,lng:profile?.home_lng});
  job={...job,territory_match:territoryMatch ? {lat:profile.home_lat,lng:profile.home_lng} : null};
  let points=[];
  if(evidence) {
    if(sameSource && evidence.status==='validated' && evidence.scope?.kind==='local') {
      points=(evidence.locations||[]).filter(validPoint);
      if(!points.length && validPoint({lat:job.job_lat,lng:job.job_lng,state:job.state}))
        points=[{lat:job.job_lat,lng:job.job_lng,state:job.state}];
    }
  } else if(validPoint({lat:job.job_lat,lng:job.job_lng,state:job.state})) {
    points=[{lat:job.job_lat,lng:job.job_lng,state:job.state}];
  }
  if(coverage && !(evidence?.scope?.kind==='local' && /^explicit_(?:title|description)/.test(evidence.scope.reason||'')))points=points.filter(inside);
  if(!points.length)return {...job,job_lat:null,job_lng:null,distance_miles:null};
  if(![profile?.home_lat,profile?.home_lng].every(Number.isFinite))return {...job,distance_miles:null};
  const distance=p=>distanceMiles(profile.home_lat,profile.home_lng,p.lat,p.lng);
  const nearest=points.reduce((a,b)=>distance(a)<=distance(b)?a:b);
  return {...job,job_lat:nearest.lat,job_lng:nearest.lng,state:nearest.state,distance_miles:Math.round(distance(nearest))};
}
module.exports={attachSearchDistance};
