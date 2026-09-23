// Bounded September 23 repair. Dry-run by default; never closes any job.
require('dotenv').config();
const {createClient}=require('@supabase/supabase-js');
const {deterministicJobAnalysis,deterministicIndustryEvidence,CANONICAL_INDUSTRIES}=require('../deterministicJobAnalysis');
const {generateEmbedding}=require('../ai/embeddings');
const REPAIR='2026-09-23-ingestion-104';
function analysisPatch(job,employer){
 const input={title:job.title_original,description:job.description_html||job.description_text,employerIndustry:employer?.industry||job.industry};
 if(!job.ai_analysis){const analysis=deterministicJobAnalysis(input);return analysis?{ai_analysis:analysis}:null;}
 const present=[...(job.ai_analysis.product_categories||[]),...(job.ai_analysis.market_industries||[])];
 if(present.some(x=>CANONICAL_INDUSTRIES.includes(x)))return null;
 const evidence=deterministicIndustryEvidence(input);
 if(!evidence.labels.length)return null;
 return {ai_analysis:{...job.ai_analysis,product_categories:evidence.labels,market_industries:evidence.labels,classification_source:'deterministic_evidence_2026_09_23'}};
}
async function run(){
 const apply=process.argv.includes('--apply'),embeddings=process.argv.includes('--embeddings');
 const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{global:{fetch:(u,o={})=>fetch(u,{...o,signal:AbortSignal.timeout(20000)})}});
 const {data:employers,error:ee}=await db.from('employers').select('id,industry');if(ee)throw ee;
 const map=new Map(employers.map(e=>[e.id,e])),candidates=[];
 for(let from=0;;from+=250){const {data,error}=await db.from('jobs').select('id,employer_id,company_name,title_original,description_text,description_html,industry,ai_analysis,updated_at').eq('status','active').eq('moderation_status','approved').order('id').range(from,from+249);if(error)throw error;for(const job of data){const patch=analysisPatch(job,map.get(job.employer_id));if(patch)candidates.push({job,patch});}if(data.length<250)break;}
 console.log(JSON.stringify({mode:apply?'apply':'dry-run',analysis_candidates:candidates.length,by_employer:candidates.reduce((m,x)=>(m[x.job.company_name]=(m[x.job.company_name]||0)+1,m),{})}));
 let changed=0,conflicts=0,embedded=0,embeddingFailures=0;
 const save=async(job,patch)=>{
  const before=Object.fromEntries(Object.keys(patch).map(k=>[k,job[k]??null]));
  const {error:b}=await db.from('ingestion_repair_backups').upsert({repair_id:REPAIR+(patch.job_embedding?'-embeddings':''),table_name:'jobs',row_id:job.id,before_row:before},{onConflict:'repair_id,table_name,row_id',ignoreDuplicates:true});if(b)throw b;
  let q=db.from('jobs').update(patch).eq('id',job.id).eq('status','active');if(patch.job_embedding)q=q.is('job_embedding',null);q=job.updated_at?q.eq('updated_at',job.updated_at):q.is('updated_at',null);
  const {data,error}=await q.select('id');if(error)throw error;if(!data.length){conflicts++;return false;}return true;
 };
 if(apply)for(const {job,patch}of candidates)if(await save(job,patch))changed++;
 if(embeddings){
  const {data:missing,error}=await db.from('jobs').select('id,title_original,description_text,updated_at').eq('status','active').eq('moderation_status','approved').is('job_embedding',null).order('id').limit(450);if(error)throw error;
  console.log(JSON.stringify({embedding_candidates:missing.length,limit:450}));
  const deadline=Date.now()+10*60000;
  if(apply)for(const job of missing){if(Date.now()>deadline||embeddingFailures>=3)break;try{const vector=await generateEmbedding(job.title_original+'\n\n'+(job.description_text||''));if(vector.length!==1536||vector.some(x=>!Number.isFinite(x)))throw Error('Invalid embedding');if(await save(job,{job_embedding:vector}))embedded++;}catch(e){embeddingFailures++;console.error('Embedding deferred:',e.message.slice(0,150));}if(embedded&&embedded%50===0)console.log(JSON.stringify({embedded}));}
 }
 console.log(JSON.stringify({changed,conflicts,embedded,embeddingFailures,repair_id:REPAIR}));
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={analysisPatch};
