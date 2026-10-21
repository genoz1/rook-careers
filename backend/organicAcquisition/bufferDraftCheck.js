'use strict';
const {createBufferAdapter}=require('./bufferAdapter');
const {BUFFER_API_ENDPOINT}=require('../socialBuffer');
async function verifyDrafts({token,linkedinChannelId,facebookChannelId,httpFetch=fetch,confirm=false}){
 if(!confirm)throw Error('Explicit nonpublic draft-test confirmation required');
 const channels=await createBufferAdapter({token,linkedinChannelId,facebookChannelId,httpFetch}).channels();
 const created=[],results=[];
 async function query(query,input){const r=await httpFetch(BUFFER_API_ENDPOINT,{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{input}})});const d=await r.json();if(!r.ok||d.errors?.length)throw Error('Buffer nonpublic draft check failed');return d.data;}
 try{
  for(const c of channels){
   const input={channelId:c.id,text:'ROOK integration validation — nonpublic test draft only.',mode:'addToQueue',schedulingType:'automatic',saveToDraft:true,needsApproval:false,assets:[],...(c.service==='facebook'?{metadata:{facebook:{type:'post'}}}:{})};
   const d=await query('mutation CreatePost($input:CreatePostInput!){createPost(input:$input){... on PostActionSuccess{post{id status}} ... on MutationError{message}}}',input);
   const p=d.createPost?.post;if(!p?.id)throw Error('No diagnostic draft receipt');created.push(p.id);if(p.status!=='draft')throw Error('Provider did not confirm a nonpublic draft');results.push({service:c.service,draftConfirmed:true});
  }
 }finally{
  // Only IDs created by this run, never existing queued or published posts.
  for(const id of created){const d=await query('mutation DeleteDraft($input:DeletePostInput!){deletePost(input:$input){__typename}}',{id});if(d.deletePost?.__typename!=='DeletePostSuccess')throw Error('Diagnostic draft cleanup not confirmed');}
 }
 return {results,cleanupConfirmed:true,publicPublicationTested:false};
}
module.exports={verifyDrafts};
