const {distanceMiles}=require('./geocoding');
const {validPoint}=require('./jobLocationScope');

// Search is an unscored catalog: use the nearest verified location without
// applying Dashboard's radius. Remote arrangement never removes a city point.
function attachSearchDistance(job, profile) {
  const evidence=job.location_evidence;
  const sameSource=evidence?.source_location===String(job.location_raw||'').trim().replace(/\s+/g,' ');
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
  if(!points.length)return {...job,job_lat:null,job_lng:null,distance_miles:null};
  if(![profile?.home_lat,profile?.home_lng].every(Number.isFinite))return {...job,distance_miles:null};
  const distance=p=>distanceMiles(profile.home_lat,profile.home_lng,p.lat,p.lng);
  const nearest=points.reduce((a,b)=>distance(a)<=distance(b)?a:b);
  return {...job,job_lat:nearest.lat,job_lng:nearest.lng,state:nearest.state,distance_miles:Math.round(distance(nearest))};
}
module.exports={attachSearchDistance};
