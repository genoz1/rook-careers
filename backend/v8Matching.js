// V8-only retrieval: inspect the complete, small geography projection first,
// then fetch scoring payloads only for eligible IDs. No cached inventory or
// primary-city radius approximation: the existing territory rules are final.
const {performance}=require('node:perf_hooks');
const {prepareJob}=require('./v7Location');
const {rankPool,hydrateDescriptionTerritories,JOB_LIST_COLUMNS_NO_DESCRIPTION}=require('./v7Matching');
const GEO_COLUMNS='id,source_type,title_original,location_raw,location_evidence,extraction_evidence,job_lat,job_lng,state';
const PAGE_SIZE=500, CONCURRENCY=4;
const indexes=new WeakMap();
function indexFor(db) {
  if(!indexes.has(db))indexes.set(db,require('./v8MatchingIndex').createIndex(db,{readPages:pages}));
  return indexes.get(db);
}
function startIndex(db){indexFor(db).start();}
async function pages(db,columns,timing){
  const rows=[];
  for(let offset=0;;offset+=PAGE_SIZE*CONCURRENCY){
    // Each request has its own query builder; range() mutates Supabase builders.
    const results=await Promise.all(Array.from({length:CONCURRENCY},(_,i)=>{
      timing.candidate_page_reads++;
      return db.from('jobs').select(columns).eq('status','active').eq('moderation_status','approved')
        .order('id',{ascending:true}).range(offset+i*PAGE_SIZE,offset+(i+1)*PAGE_SIZE-1);
    }));
    // Speculative final-wave offsets can exceed the end of the table.
    // PostgREST may report that as PGRST103 instead of an empty page.
    for(const result of results){
      if(result.error?.code==='PGRST103'){result.data=[];result.error=null;}
      if(result.error)throw new Error('Candidate retrieval failed');
    }
    for(const result of results)rows.push(...(result.data||[]));
    if(results.some(r=>(r.data||[]).length<PAGE_SIZE))return rows;
  }
}
async function readCandidates(db,profile,timing={}){
  const started=performance.now();
  timing.candidate_page_reads=0;timing.scoring_page_reads=0;
  let candidates=await pages(db,GEO_COLUMNS,timing);
  timing.candidate_count=candidates.length;
  candidates=await hydrateDescriptionTerritories(db,candidates);
  timing.candidate_retrieval_ms=performance.now()-started;
  const geoStarted=performance.now();
  const eligible=candidates.filter(j=>prepareJob(j,profile));
  timing.geographic_count=eligible.length;
  timing.geography_ms=performance.now()-geoStarted;
  const fetchStarted=performance.now(),jobs=[];
  const chunks=[];
  for(let i=0;i<eligible.length;i+=200)chunks.push(eligible.slice(i,i+200).map(j=>j.id));
  for(let i=0;i<chunks.length;i+=CONCURRENCY){
    const results=await Promise.all(chunks.slice(i,i+CONCURRENCY).map(ids=>{
      timing.scoring_page_reads++;
      return db.from('jobs').select(JOB_LIST_COLUMNS_NO_DESCRIPTION).eq('status','active')
        .eq('moderation_status','approved').in('id',ids);
    }));
    for(const result of results){if(result.error)throw new Error('Scoring retrieval failed');jobs.push(...(result.data||[]));}
  }
  // Rehydrate current source sentences and recheck current geography in rankPool;
  // never combine stale thin-row evidence with a refreshed scoring row.
  const hydrated=await hydrateDescriptionTerritories(db,jobs);
  timing.scoring_candidate_count=hydrated.length;
  timing.scoring_retrieval_ms=performance.now()-fetchStarted;
  return hydrated;
}
async function rank(db,profile,unused=[],timing={}){
  const local=await indexFor(db).current(timing);
  const hydrated=local||await readCandidates(db,profile,timing);
  if(local){
    timing.database_fallback=0;timing.candidate_retrieval_ms=0;timing.scoring_retrieval_ms=0;
    timing.candidate_page_reads=0;timing.scoring_page_reads=0;timing.candidate_count=local.length;
  }
  const scoreStarted=performance.now();
  const ranked=rankPool(hydrated,profile,[]);
  timing.scoring_ms=performance.now()-scoreStarted;
  return ranked;
}
function previewRecency(job){
  return new Date(job.date_posted||job.first_seen_at||0).getTime()||0;
}
// Anonymous bootstrap has no home geography. Prefer a readable mix of roles,
// industries, and cities over the newest 30 rows of one repeated title.
function diversifyNationalPreview(jobs,limit=30){
  const {isUsEligibleJob}=require('./jobEligibility');
  const {generalizedRole,safeLocationLabel}=require('./maskedPresentation');
  const {classify}=require('../public/rook-job-classification');
  const eligible=jobs.filter(isUsEligibleJob).sort((a,b)=>previewRecency(b)-previewRecency(a));
  const selected=[],seen=new Set();
  const roleCounts=new Map(),industryCounts=new Map(),locationCounts=new Map();
  const pass=(maxRole,maxIndustry,maxLocation)=>{
    for(const job of eligible){
      if(seen.has(job.id)||selected.length>=limit)continue;
      const role=generalizedRole(job);
      const industry=(classify(job).labels||[])[0]||'Medical sales';
      const location=safeLocationLabel(job)||String(job.state||'').toUpperCase()||'National';
      if((roleCounts.get(role)||0)>=maxRole)continue;
      if((industryCounts.get(industry)||0)>=maxIndustry)continue;
      if((locationCounts.get(location)||0)>=maxLocation)continue;
      seen.add(job.id);selected.push(job);
      roleCounts.set(role,(roleCounts.get(role)||0)+1);
      industryCounts.set(industry,(industryCounts.get(industry)||0)+1);
      locationCounts.set(location,(locationCounts.get(location)||0)+1);
    }
  };
  // Widen caps only when the inventory cannot fill a varied first viewport.
  pass(3,10,2);
  pass(5,18,4);
  pass(Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY,Number.POSITIVE_INFINITY);
  return selected;
}
async function nationalPreview(db,timing={}){
  const local=await indexFor(db).current(timing)||await pages(db,JOB_LIST_COLUMNS_NO_DESCRIPTION,timing);
  return diversifyNationalPreview(local,30);
}
module.exports={rank,readCandidates,nationalPreview,diversifyNationalPreview,GEO_COLUMNS,startIndex,indexFor,pages};
