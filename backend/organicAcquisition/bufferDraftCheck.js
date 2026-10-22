'use strict';
const crypto = require('node:crypto');
const {createBufferAdapter} = require('./bufferAdapter');
const {BUFFER_API_ENDPOINT} = require('../socialBuffer');
async function verifyDrafts({token,linkedinChannelId,facebookChannelId,httpFetch=fetch,confirm=false}) {
 if (!confirm) throw Error('Explicit nonpublic draft-test confirmation required');
 const channels = await createBufferAdapter({token,linkedinChannelId,facebookChannelId,httpFetch}).channels();
 const created = [], results = [], marker = 'ROOK nonpublic integration check ' + crypto.randomUUID();
 async function query(query,input) {
  const r = await httpFetch(BUFFER_API_ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{input}})});
  const d = await r.json();
  if (!r.ok || d.errors?.length) throw Error('Buffer nonpublic draft check failed');
  return d.data;
 }
 let failure;
 try {
  for (const c of channels) {
   const input = {channelId:c.id,text:marker,mode:'addToQueue',schedulingType:'automatic',saveToDraft:true,needsApproval:false,assets:[],...(c.service==='facebook'?{metadata:{facebook:{type:'post'}}}:{})};
   const d = await query('mutation CreatePost($input:CreatePostInput!){createPost(input:$input){... on PostActionSuccess{post{id status}} ... on MutationError{message}}}',input);
   const p = d.createPost?.post;
   if (!p?.id) throw Error('No diagnostic draft receipt; reconcile before retrying');
   created.push(p.id);
   if (p.status !== 'draft') throw Error('Provider did not confirm a nonpublic draft');
   const read = await query('query ReadDiagnosticDraft($input:PostInput!){post(input:$input){id status channelId text}}',{id:p.id});
   if (read.post?.id !== p.id || read.post.status !== 'draft' || read.post.channelId !== c.id || read.post.text !== marker) throw Error('Diagnostic draft readback failed');
   results.push({service:c.service,draftConfirmed:true,readbackConfirmed:true});
  }
 } catch (e) { failure = e; }
 // Attempt every cleanup even when creation/readback or another deletion failed.
 // Delete only receipt IDs created by this invocation; never discover targets by name.
 const cleanup = await Promise.allSettled(created.map(async id => {
  const d = await query('mutation DeleteDraft($input:DeletePostInput!){deletePost(input:$input){__typename}}',{id});
  if (d.deletePost?.__typename !== 'DeletePostSuccess') throw Error('Diagnostic draft cleanup not confirmed');
 }));
 if (cleanup.some(r => r.status === 'rejected')) throw Error('Diagnostic draft cleanup incomplete; do not repeat creation until reconciled');
 if (failure) throw failure;
 return {results,cleanupConfirmed:true,cleanupCount:created.length,publicPublicationTested:false};
}
module.exports = {verifyDrafts};
