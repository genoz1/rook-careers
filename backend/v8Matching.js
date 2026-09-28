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
module.exports={rank,readCandidates,GEO_COLUMNS,startIndex,indexFor,pages};
