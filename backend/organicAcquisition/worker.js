'use strict';
const crypto=require('node:crypto');
const {getEasternParts}=require('../socialScheduler');
const {collect}=require('../../scripts/collectOrganicBaseline');
const {candidates,reports,ORIGIN}=require('./content');
const {digest}=require('./security');
const {nearSlot,repeatsContent}=require('./coordination');
const marketing=require('./marketing');
async function checkDestination(url,{httpFetch=fetch,expectedHash}={}){
 const u=new URL(url);if(u.origin!==ORIGIN||u.username||u.password)return false;
 const res=await httpFetch(u,{redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(res.status!==200)return false;
 const html=await res.text();if(html.length>1500000)return false;
 const $=require('cheerio').load(html);const canonical=$('link[rel="canonical"]').attr('href');
 return canonical?.replace(/\/$/,'')===u.origin+u.pathname.replace(/\/$/,'')&&$('h1').length>0&&(!expectedHash||$('[data-content-hash]').attr('data-content-hash')===expectedHash);
}
async function refreshInventory(store,{collectSnapshot=collect,now,clock=Date.now}={}){
 const started=now??clock();
 const old=await store.call('get',{kind:'snapshot',id:'latest'});
 if(old&&started-Date.parse(old.capturedAt)>=0&&started-Date.parse(old.capturedAt)<86400000)return old;
 const s=await collectSnapshot();require('./content').validateFresh(s,now??clock());
 await store.call('put',{kind:'snapshot',id:s.capturedAt,body:s});await store.call('put',{kind:'snapshot',id:'latest',body:s});return s;
}
async function publishReports(store,snapshot,now){
 for(const report of reports(snapshot,now)){
  const existing=await store.call('get',{kind:'report',id:report.slug});
  // One substantive report per family per month; no daily duplicate pages.
  if(!existing)await store.call('put',{kind:'report',id:report.slug,body:{...report,publishedAt:new Date(now).toISOString()}});
 }
}
async function replenish(store,{channels,now=Date.now(),check=checkDestination,externalSchedule=[]}){
 const snapshot=await store.call('get',{kind:'snapshot',id:'latest'});
 const reportRows=await store.call('list',{kind:'report'}), existing=await store.call('outbox');
 const pool=candidates(snapshot,now,reportRows),performance=await store.call('get',{kind:'metrics',id:'marketing-performance'});let added=0;
 // Pre-fill a bounded week; dispatch missed slots for up to seven days after an outage.
 for(let offset=0;offset<7;offset++){
  const d=new Date(now+offset*86400000), p=getEasternParts(d);
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(d);
  if(!['Mon','Wed','Fri'].includes(weekday))continue;
  // Compute Eastern 11:30am (away from the existing 10am worker) without a fixed UTC offset (including DST changes).
  const due=new Date(Date.UTC(+p.dateStr.slice(0,4),+p.dateStr.slice(5,7)-1,+p.dateStr.slice(8,10),14));
  for(let i=0;i<2;i++){const ep=getEasternParts(due);due.setTime(due.getTime()+((11-ep.hour)*60+30-ep.minute)*60000);}
  for(const channel of channels){
   const id=digest('organic:'+p.dateStr+':'+channel.id);
   if(existing.some(r=>r.id===id))continue;
   const channelDue=new Date(due);
   for(let step=0;step<32&&externalSchedule.some(p=>nearSlot(p,channel.id,channelDue.getTime()));step++)channelDue.setTime(channelDue.getTime()+15*60000);
   let selected;
   const ordered=marketing.rank(pool,existing,channel.id,performance);
   const recent=[...externalSchedule.filter(p=>p.channelId===channel.id),...existing.filter(r=>r.channel===channel.id&&r.status!=='replaced'&&(r.status!=='published'||now-Date.parse(r.created_at)<30*86400000))];
   for(const c of ordered){try{marketing.validateCandidate(c,{now,recent});}catch{continue;}if(existing.some(r=>r.channel===channel.id&&r.payload.contentHash===c.hash&&(r.status!=='published'||now-Date.parse(r.created_at)<30*86400000)))continue;
    if(await check(c.url,{expectedHash:c.reportHash})){selected=c;break;}}
   if(!selected){
    const row=await store.call('enqueue',{id,lane:'social',channel:channel.id,payload:{needsReplacement:true,url:ORIGIN+'/resources/',text:'',contentHash:'reserve-backlog-'+id},dueAt:channelDue.toISOString()});existing.push(row);continue;
   } // An unfilled slot remains durable work, never silent success.
   const payload=await marketing.payloadFor(store,selected,channel,id,now);
   const row=await store.call('enqueue',{id,lane:'social',channel:channel.id,payload,dueAt:channelDue.toISOString()});existing.push(row);added++;
  }
 }return {added,reserveSize:pool.length};
}
async function dispatchOne(store,{adapter,now=Date.now(),check=checkDestination,checkMedia=async url=>{const r=await fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(12000)});return r.status===200&&/image\/jpeg/i.test(r.headers.get('content-type')||'');}}){
 const token=crypto.randomUUID();const row=await store.call('claim',{lane:'social',token,now:new Date(now).toISOString()});if(!row)return null;
 const finish=(status,receipt=null,error=null,delay=300000)=>store.call('outcome',{id:row.id,token,status,receipt,error,dueAt:new Date(now+delay).toISOString()});
 try{
  // A reclaimed lease might have died after submitting: reconcile, never send blindly.
  if(['working','uncertain','accepted'].includes(row.status)){
   const receipt=await adapter.reconcile(row);
   await finish(receipt.status==='published'?'published':receipt.status==='failed'?'retry':receipt.status==='accepted'?'accepted':'uncertain',receipt,receipt.status==='unknown'?'provider_receipt_unresolved':null,receipt.status==='unknown'?Math.min(21600000,3600000*2**Math.min(row.attempts,3)):Math.min(21600000,300000*2**Math.min(row.attempts,6)));
   return {id:row.id,status:receipt.status};
  }
  let qualityPassed=false;try{marketing.validatePayload(row.payload,{snapshot:await store.call('get',{kind:'snapshot',id:'latest'}),now});qualityPassed=true;}catch{/* Regenerate before any new provider send. */}
  const stale=!qualityPassed||row.payload.needsReplacement||(row.payload.observedAt&&now-Date.parse(row.payload.observedAt)>86400000);
  if(stale||!await check(row.payload.url,{expectedHash:row.payload.reportHash})){
   // Queue a reserve replacement using a unique key; retire only this unusable attempt.
   const old=await store.call('outbox'),channels=await adapter.channels(),channel=channels.find(c=>c.id===row.channel);if(!channel)throw Object.assign(Error('Unapproved company channel'),{definitelyNotAccepted:true});let replacement;
   const recent=old.filter(r=>r.id!==row.id&&r.channel===row.channel&&r.status!=='replaced'&&(r.status!=='published'||now-Date.parse(r.created_at)<30*86400000));
   for(const c of marketing.rank(candidates(null,now,[]),recent,row.channel)){try{marketing.validateCandidate(c,{now,recent});}catch{continue;}if(old.some(r=>r.channel===row.channel&&r.payload.contentHash===c.hash&&(r.status!=='published'||now-Date.parse(r.created_at)<30*86400000)))continue;if(await check(c.url)){replacement=c;break;}}
   if(!replacement){await finish('retry',null,'reserve_temporarily_unavailable',3600000);return {status:'retry'};}
   const id=digest(row.id+replacement.hash),payload=await marketing.payloadFor(store,replacement,channel,id,now);
   await store.call('enqueue',{id,lane:'social',channel:row.channel,payload,dueAt:new Date(now).toISOString()});
   await finish('replaced',null,'automatic_reserve_replacement');return {status:'replaced'};
  }
  // Row is already durably marked working before external side effect.
  if(row.payload.imageUrl&&!await checkMedia(row.payload.imageUrl))throw Object.assign(Error('ROOK creative temporarily unavailable'),{definitelyNotAccepted:true});
  const receipt=await adapter.publish(row);
  await finish(receipt.status==='published'?'published':'accepted',receipt);return {id:row.id,status:receipt.status};
 }catch(e){
  const reconciling=['working','uncertain','accepted'].includes(row.status);
  const certain=!reconciling&&(e.isMutationError===true||e.definitelyNotAccepted===true);
  await finish(certain?'retry':'uncertain',null,certain?'provider_rejected':'provider_result_uncertain',Math.min(21600000,60000*2**Math.min(row.attempts,8)));
  return {id:row.id,status:certain?'retry':'uncertain'};
 }
}
async function health(store,now=Date.now()){
 const rows=(await store.call('outbox')).filter(r=>r.lane==='social');return {generatedAt:new Date(now).toISOString(),published:rows.filter(r=>r.status==='published').length,queued:rows.filter(r=>['ready','retry'].includes(r.status)).length,uncertain:rows.filter(r=>['uncertain','accepted'].includes(r.status)).length,overdue:rows.filter(r=>['ready','retry','uncertain','accepted','working'].includes(r.status)&&now-Date.parse(r.due_at)>86400000).length};
}
module.exports={checkDestination,refreshInventory,publishReports,replenish,dispatchOne,health};
