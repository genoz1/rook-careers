'use strict';
const marketing=require('./marketing'),buffer=require('../socialBuffer');
async function query(token,query,input,httpFetch=fetch){const r=await httpFetch(buffer.BUFFER_API_ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{input}}),signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok||d.errors?.length)throw Error('Scoped Buffer operation failed');return d.data;}
const fields='id status channelId text dueAt allowedActions assets{mimeType source} metadata{... on FacebookPostMetadata{linkAttachment{url title thumbnail}} ... on LinkedInPostMetadata{linkAttachment{url title thumbnail}}}';
function presentation(payload,service){const link=payload.format==='link'?{url:payload.shortUrl,title:payload.headline,description:payload.description,thumbnail:{url:payload.imageUrl}}:null;return {text:payload.text,assets:payload.format==='image'?[{image:{url:payload.imageUrl}}]:[],metadata:service==='facebook'?{facebook:{type:'post',linkAttachment:link}}:{linkedin:{linkAttachment:link}}};}
async function companyChannels(env){const ids=[env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID];if(ids.some(x=>!x)||ids[0]===ids[1])throw Error('Explicit company channel IDs required');const out=[];for(const id of ids){const c=await buffer.getChannelDetails(env.BUFFER_ACCESS_TOKEN,id);if(c.type!=='page'||c.isDisconnected||c.isLocked||!c.allowedActions.includes('scheduleUpdates')||!['linkedin','facebook'].includes(c.service)||!/rook/i.test(c.name+' '+c.displayName))throw Error('Company-only authorization failed');out.push(c);}if(new Set(out.map(c=>c.service)).size!==2)throw Error('Both company services required');return out;}
async function select(store,channels,count=10){
 const snapshot=await store.call('get',{kind:'snapshot',id:'latest'}),pool=marketing.candidates(snapshot,Date.now()),rows=[],selected=[];
 for(let i=0;i<count;i++){const channel=channels[i%channels.length],category=marketing.CYCLE[i%20];let chosen;
  for(const c of pool.filter(c=>c.category===category)){try{marketing.validateCandidate(c,{recent:selected.map(x=>({text:x.candidate.text}))});chosen=c;break;}catch{}}
  if(!chosen)throw Error('Insufficient quality reserve');const id=require('./security').digest('marketing-review-v2:'+i+':'+channel.id);const payload=await marketing.payloadFor(store,chosen,channel,id);selected.push({candidate:chosen,channel,payload,id});rows.push({channel:channel.id,payload,status:'ready'});
 }return selected;
}
async function previewDrafts(runtime,env,{lookup=companyChannels,request=query}={}){
 const previous=await runtime.store.call('get',{kind:'config',id:'marketing-review-drafts'});if(previous?.created?.length||previous?.attempt)throw Error('Reconcile existing diagnostic drafts before creating more');
 const channels=await lookup(env),items=await select(runtime.store,channels),token=env.BUFFER_ACCESS_TOKEN,created=[];
 // Only explicit disposable diagnostics are created. Nothing is scheduled or published.
 for(const item of items){const input={channelId:item.channel.id,...presentation(item.payload,item.channel.service),mode:'addToQueue',schedulingType:'automatic',saveToDraft:true,aiAssisted:true};
  await runtime.store.call('put',{kind:'config',id:'marketing-review-drafts',body:{created,complete:false,attempt:{channel:item.channel.id,candidateId:item.candidate.id,startedAt:new Date().toISOString()}}});
  const r=await request(token,`mutation MarketingPreview($input:CreatePostInput!){createPost(input:$input){__typename ... on PostActionSuccess{post{${fields}}} ... on MutationError{message}}}`,input);const p=r.createPost?.post;
  if(!p?.id){if(r.createPost?.message){await runtime.store.call('put',{kind:'config',id:'marketing-review-drafts',body:{created,complete:false,attempt:null}});throw Error('Buffer rejected diagnostic: '+String(r.createPost.message).slice(0,300));}throw Error('Draft creation incomplete; reconcile before retry');}
  created.push({id:p.id,channel:p.channelId,service:item.channel.service,category:item.candidate.category,candidateId:item.candidate.id});
  await runtime.store.call('put',{kind:'config',id:'marketing-review-drafts',body:{created,complete:false}});
  if(p.status!=='draft'||p.channelId!==item.channel.id)throw Error('Unexpected draft state; reconcile recorded receipt');
  const read=(await request(token,`query MarketingPreviewRead($input:PostInput!){post(input:$input){${fields}}}`,{id:p.id})).post;
  if(read.status!=='draft'||read.text!==item.payload.text||(item.payload.format==='image'&&!read.assets?.length)||(item.payload.format==='link'&&!read.metadata?.linkAttachment?.thumbnail))throw Error('Rendered preview metadata mismatch; preserve diagnostic receipts');
 }
 await runtime.store.call('put',{kind:'config',id:'marketing-review-drafts',body:{created,complete:true}});return {drafts:created,publicPostsCreated:0};
}
async function cleanupDrafts(runtime,env){const record=await runtime.store.call('get',{kind:'config',id:'marketing-review-drafts'});if(!record?.created)return {deleted:0};let deleted=0;
 if(record.attempt)throw Error('Reconcile the pending diagnostic attempt before cleanup');
 for(const item of record.created){if(![env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID].includes(item.channel))throw Error('Cleanup scope mismatch');let p;try{p=(await query(env.BUFFER_ACCESS_TOKEN,`query MarketingPreviewRead($input:PostInput!){post(input:$input){id status channelId}}`,{id:item.id})).post;}catch{throw Error('Draft cleanup readback unavailable');}if(p?.status!=='draft'||p.channelId!==item.channel)throw Error('Refusing to delete a non-diagnostic or published post');const d=await query(env.BUFFER_ACCESS_TOKEN,'mutation MarketingPreviewCleanup($input:DeletePostInput!){deletePost(input:$input){__typename}}',{id:item.id});if(d.deletePost?.__typename!=='DeletePostSuccess')throw Error('Diagnostic cleanup unconfirmed');deleted++;await runtime.store.call('put',{kind:'config',id:'marketing-review-drafts',body:{...record,created:record.created.slice(deleted),complete:true,deleted}});}
 return {deleted,cleanupConfirmed:true};
}
async function review(runtime,env,{apply=false}={}){
 if(env.ACQ_PUBLICATION_APPROVED==='true')throw Error('Temporarily hold new publishing before queue revision');
 const channels=await companyChannels(env);if(channels.some(c=>!c.isQueuePaused))throw Error('Both company queues must be paused during revision');
 const snapshot=await runtime.store.call('get',{kind:'snapshot',id:'latest'}),pool=marketing.candidates(snapshot,Date.now()),existing=await runtime.store.call('outbox'),report={reserved:[],buffer:[],publishedPreserved:existing.filter(x=>x.status==='published').length,applied:apply};
 const used=existing.filter(x=>x.status==='published'),selectCandidate=(channel)=>{for(const c of marketing.rank(pool,used,channel.id)){try{marketing.validateCandidate(c,{recent:used.filter(r=>r.channel===channel.id)});return c;}catch{}}throw Error('No quality replacement available');};
 // Revise only known unsent/unclaimed rows. Existing provider receipts and sent history are immutable here.
 for(const row of existing.filter(r=>r.lane==='social'&&['ready','retry'].includes(r.status)&&!r.receipt&&!r.lease_token).sort((a,b)=>Date.parse(a.due_at)-Date.parse(b.due_at))){const channel=channels.find(c=>c.id===row.channel);if(!channel)throw Error('Reserved queue scope mismatch');const c=selectCandidate(channel),payload=await marketing.payloadFor(runtime.store,c,channel,row.id);
  if(apply){const r=await runtime.store.client.from('rook_acq_outbox').update({payload,error_code:null,updated_at:new Date().toISOString()}).eq('id',row.id).eq('status',row.status).is('receipt',null).is('lease_token',null).select('id');if(r.error||r.data?.length!==1)throw Error('Reserved row changed; stop revision');}
  used.push({...row,payload});report.reserved.push({id:row.id,channel:row.channel,category:c.category,dueAt:row.due_at});
 }
 for(const org of new Set(channels.map(c=>c.organizationId))){const queue=await buffer.readQueue(env.BUFFER_ACCESS_TOKEN,org,{channelIds:channels.map(c=>c.id)});
  for(const row of queue.posts){if(row.status!=='scheduled')throw Error('Provider queue is sending; stop revision');const channel=channels.find(c=>c.id===row.channelId);if(!channel)throw Error('Provider scope mismatch');const c=selectCandidate(channel),id=require('./security').digest('buffer-review:'+row.id),payload=await marketing.payloadFor(runtime.store,c,channel,id);
   if(apply){const before=(await query(env.BUFFER_ACCESS_TOKEN,`query ReviewCompanyPost($input:PostInput!){post(input:$input){${fields}}}`,{id:row.id})).post;if(before.status!=='scheduled'||before.channelId!==channel.id||before.dueAt!==row.dueAt||!before.allowedActions.includes('updatePost'))throw Error('Provider queue changed before edit');
    await runtime.store.call('put',{kind:'config',id:'marketing-backup-'+row.id,body:{...before,backedUpAt:new Date().toISOString()}});
    const result=(await query(env.BUFFER_ACCESS_TOKEN,`mutation ReviewCompanyPost($input:EditPostInput!){editPost(input:$input){... on PostActionSuccess{post{${fields}}} ... on MutationError{message}}}`,{id:row.id,...presentation(payload,channel.service),aiAssisted:true})).editPost?.post;
    if(result?.status!=='scheduled'||result.channelId!==channel.id||result.dueAt!==row.dueAt||result.text!==payload.text)throw Error('Provider revision readback incomplete; stop before resume');
   }
   used.push({id,channel:channel.id,payload,status:'ready'});report.buffer.push({id:row.id,channel:channel.id,category:c.category,dueAt:row.dueAt});
  }
 }return report;
}
module.exports={presentation,companyChannels,select,previewDrafts,cleanupDrafts,review};
