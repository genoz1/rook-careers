require('dotenv').config();
const {randomUUID}=require('crypto');
const {db,result}=require('./store');
const {imageFor,urlFor}=require('./catalog');
const {nyWallClockToUtc}=require('../socialAutomation');
const {getEasternParts}=require('../socialScheduler');
const content=require('./content');
function slots(now=new Date(),count=Number(process.env.ARTICLES_PER_DAY||2)){
 if(!Number.isInteger(count)||count<1||count>12)throw Error('ARTICLES_PER_DAY must be an integer from 1 to 12');
 const day=getEasternParts(now).dateStr;
 return Array.from({length:count},(_,slot)=>{
  const minutes=9*60+Math.floor(slot*12*60/count);
  return {day,slot,due:nyWallClockToUtc(day,Math.floor(minutes/60),minutes%60).toISOString()};
 }).filter(s=>new Date(s.due)<=now);
}
async function verifyPublic(article,client=db(),http=fetch){
 const url=urlFor(article.slug),response=await http(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok||!String(response.headers.get('content-type')).includes('text/html'))throw Error('Public article verification failed');
 const html=await response.text();
 if(!html.includes(`data-resource-slug="${article.slug}"`)||!html.includes(`href="${url}"`))throw Error('Public article content mismatch');
 await result(client.from('resource_articles').update({public_verified_at:new Date().toISOString()}).eq('slug',article.slug));
 return true;
}
async function tick(deps={}){
 if(process.env.RESOURCES_AUTOPUBLISH_ENABLED!=='true'&&!deps.controlled)return {state:'disabled'};
 const client=deps.db||db(),now=deps.now||new Date();
 for(const s of slots(now)){
  for(let fallback=0;fallback<3;fallback++){
   const owner=randomUUID();
   const topic=await result(client.rpc('claim_resource_slot',{p_day:s.day,p_slot:s.slot,p_due:s.due,p_owner:owner}));
   if(!topic)break;
   const existing=await result(client.from('resource_articles').select('slug,title,body_hash,body_html,image_path').order('published_at',{ascending:false}).limit(500));
   let valid,reason='Validation failed';
   for(let attempt=0;attempt<2;attempt++){
    try{valid=content.validate(await (deps.generate||content.generate)(topic,attempt?reason:''),topic,existing);
     await (deps.review||content.review)(valid,topic);break;
    }catch(error){
     valid=null;
     // Authentication/configuration/provider failures stop the run instead of burning the topic inventory.
     if(error.code&&error.code!=='malformed_response')throw error;
     reason=error.message;
    }
   }
   if(!valid){await result(client.rpc('finish_resource_slot',{p_day:s.day,p_slot:s.slot,p_owner:owner,p_article:null,p_error:reason}));continue;}
   valid.image_path=imageFor(topic.category,existing?.[0]?.image_path);valid.url=urlFor(topic.slug);
   await result(client.rpc('finish_resource_slot',{p_day:s.day,p_slot:s.slot,p_owner:owner,p_article:valid}));
   // Publication commits independently: verification/social errors never roll it back.
   try{await (deps.verifyPublic||verifyPublic)(topic,client);}catch{console.warn('[resources] Article published; public verification pending');}
   if(deps.controlled)return {state:'published',slug:topic.slug};
   break;
  }
 }
 // Recover verification after a crash between commit and the public GET.
 const pending=await result(client.from('resource_articles').select('slug').is('public_verified_at',null).limit(10));
 for(const a of pending||[])try{await (deps.verifyPublic||verifyPublic)(a,client);}catch{console.warn('[resources] Public verification deferred');}
 return {state:'complete'};
}
let running=false;
function start(){
 if(process.env.RESOURCES_AUTOPUBLISH_ENABLED!=='true')return;
 const run=async()=>{if(running)return;running=true;try{await tick();await require('./meta').dispatch();}catch(e){console.error('[resources] Worker failed; code:',e.code||'operation_failed');}finally{running=false;}};
 setTimeout(run,15000).unref();setInterval(run,5*60*1000).unref();
}
async function main(){
 const command=process.argv[2];
 if(command==='seed'){
  const topics=require('./topics');await result(db().from('resource_topics').upsert(topics,{onConflict:'slug',ignoreDuplicates:true}));console.log('Seeded',topics.length,'topics (existing states preserved)');
 }else if(command==='tick')console.log(await tick());
 else if(command==='publish-one'&&process.argv.includes('--confirm-publish'))console.log(await tick({controlled:true}));
 else if(command==='verify'){const rows=await result(db().from('resource_articles').select('slug').is('public_verified_at',null));for(const a of rows)await verifyPublic(a);console.log('Public verification complete');}
 else if(command==='status'){for(const table of ['resource_slots','resource_distribution'])console.log(table,await result(db().from(table).select(table==='resource_slots'?'day,slot,state,due_at':'article_slug,channel,state').limit(30)));}
 else throw Error('Use seed | tick | status | verify | publish-one --confirm-publish');
}
if(require.main===module)main().catch(e=>{console.error('Resources command failed:',e.code||e.message);process.exitCode=1;});
module.exports={tick,slots,verifyPublic,start};
