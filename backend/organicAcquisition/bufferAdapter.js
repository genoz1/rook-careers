'use strict';
const buffer=require('../socialBuffer');
const {identifyRookChannels}=require('../socialChannels');
const {nearSlot}=require('./coordination');
function createBufferAdapter({token,linkedinChannelId,facebookChannelId,httpFetch=fetch,liveApproved=false,beforeRequest=async()=>{}}){
 const opts={channelIds:[linkedinChannelId,facebookChannelId],httpFetch:async(...args)=>{await beforeRequest();return httpFetch(...args);}};let validated,validatedAt=0,scheduleCache,scheduleAt=0;
 async function channels(){
  if(validated&&Date.now()-validatedAt<24*3600000)return validated;
  const all=[];for(const id of opts.channelIds)all.push(await buffer.getChannelDetails(token,id,opts));
  const result=identifyRookChannels(all,{linkedinChannelId,facebookChannelId});if(!result.ok)throw Error('ROOK company channel configuration is invalid');
  if(all.some(c=>c.type!=='page'||c.isDisconnected||c.isLocked||c.isQueuePaused||!c.allowedActions?.includes('scheduleUpdates')))throw Error('ROOK company page posting permission unavailable');
  validated=all.filter(c=>[linkedinChannelId,facebookChannelId].includes(c.id));validatedAt=Date.now();return validated;
 }
 async function schedule({force=false}={}){
  if(scheduleCache&&!force&&Date.now()-scheduleAt<6*3600000)return scheduleCache;
  const selected=await channels(),out=[];
  for(const org of new Set(selected.map(c=>c.organizationId))){const q=await buffer.readQueue(token,org,opts);out.push(...q.posts);}
  scheduleCache=out;scheduleAt=Date.now();return out;
 }
 async function publish(row){
  if(!liveApproved)throw Error('Public publishing is disabled pending launch approval');
  let ch,queue,recent;
  try{
   if(!validated)await channels();ch=validated.find(c=>c.id===row.channel);if(!ch)throw Error('Unapproved destination');
   queue=await schedule({force:true});recent=await buffer.readRecentPosts(token,ch.organizationId,opts);
   const same=[...queue,...recent].find(p=>p.channelId===row.channel&&p.text===row.payload.text);
   if(same)return {id:same.id,status:same.sentAt||same.status==='sent'?'published':'accepted',organizationId:ch.organizationId};
   if([...queue,...recent].some(p=>nearSlot(p,row.channel,Date.now())))throw Error('Existing ROOK post occupies this publication window');
  }catch(e){e.definitelyNotAccepted=true;throw e;}
  const visual=row.payload.imageUrl,card=row.payload.format==='link';
  const details=card&&visual?{linkAttachment:{url:row.payload.shortUrl,title:row.payload.headline,description:row.payload.description,thumbnail:{url:visual}}}:{};
  const metadata=ch.service==='facebook'?{facebook:{type:'post',...details}}:{linkedin:details};
  const p=await buffer.createPost(token,{channelId:row.channel,text:row.payload.text,photoUrl:!card?visual:undefined,metadata},opts);
  return {id:p.id,status:p.status==='sent'?'published':'accepted',organizationId:ch.organizationId};
 }
 async function reconcile(row){
  if(!validated)await channels();const ch=validated.find(c=>c.id===row.channel);if(!ch)throw Error('Unapproved destination');
  if(row.receipt?.id){const p=await buffer.findPostById(token,ch.organizationId,row.receipt.id,opts);if(p)return {id:p.id,status:p.status==='sent'?'published':p.status==='error'||p.status==='failed'?'failed':'accepted',organizationId:ch.organizationId};}
  const [queue,recent]=await Promise.all([buffer.readQueue(token,ch.organizationId,opts),buffer.readRecentPosts(token,ch.organizationId,opts)]);
  const p=[...queue.posts,...recent].find(p=>p.channelId===row.channel&&p.text===row.payload.text);
  // Absence from a bounded recent list does NOT prove a mutation was unaccepted.
  return p?{id:p.id,status:p.status==='sent'||p.sentAt?'published':'accepted',organizationId:ch.organizationId}:{status:'unknown'};
 }
 async function insights(){const selected=await channels();const rows=[];for(const org of new Set(selected.map(c=>c.organizationId)))rows.push(...await buffer.readCompanyMetrics(token,org,opts));return {capturedAt:new Date().toISOString(),posts:rows,note:'Provider-reported metrics can lag by a day; null metrics are unavailable, not zero. Provider defaults may also use zero for an unreported metric.'};}
 return {channels,schedule,publish,reconcile,insights};
}
module.exports={createBufferAdapter};
