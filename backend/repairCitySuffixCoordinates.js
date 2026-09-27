// One-time, idempotent repair on boot for existing "City, ST, us" rows whose
// stored point is inconsistent with the explicit source city. No external
// geocoding, matching, or ingestion is triggered.
const zipcodes=require('zipcodes');
const {cityQuery,classifyLocation,pointMatchesCity,resolveLocation}=require('./jobLocationScope');

async function repairCitySuffixCoordinates(db) {
  let inspected=0,corrected=0,conflicts=0;
  for(let offset=0;;offset+=200) {
    const {data:rows,error}=await db.from('jobs')
      .select('id,title_original,description_text,location_raw,location_evidence,source_type,extraction_evidence,job_lat,job_lng,state,updated_at')
      .eq('status','active').eq('moderation_status','approved')
      .ilike('location_raw','%, us').order('id').range(offset,offset+199);
    if(error)throw error;
    for(const job of rows) {
      inspected++;
      const city=cityQuery(job.location_raw);
      if(!city || pointMatchesCity({lat:job.job_lat,lng:job.job_lng,state:job.state},city))continue;
      const scope=classifyLocation(job);
      // A title/description territory may intentionally override an ATS HQ.
      if(scope.kind!=='local'||scope.reason!=='explicit_city_state'||scope.queries?.length!==1||
        scope.queries[0].query!==city.query)continue;
      const place=zipcodes.lookupByName(city.city,city.state)[0];
      if(!place)continue;
      const patch=await resolveLocation({...job,location_evidence:{...job.location_evidence,version:0,scope:undefined}},
        async()=>({lat:place.latitude,lng:place.longitude,state:city.state}));
      if(patch.location_evidence.status!=='validated')continue;
      let update=db.from('jobs').update(patch).eq('id',job.id)
        .eq('status','active').eq('location_raw',job.location_raw).eq('title_original',job.title_original);
      update=job.updated_at?update.eq('updated_at',job.updated_at):update.is('updated_at',null);
      const result=await update.select('id');
      if(result.error)throw result.error;
      if(result.data?.length)corrected++;else conflicts++;
    }
    if(rows.length<200)break;
  }
  return {inspected,corrected,conflicts};
}
module.exports={repairCitySuffixCoordinates};
