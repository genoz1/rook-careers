// Validate the unauthenticated bytes Buffer will fetch, not merely an image
// extension or magic prefix. Bound both network time and decompression size.
const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const MAX_BYTES=5*1024*1024;
async function preflightCheckMedia(url,{httpFetch=fetch}={}) {
 try {
  if(new URL(url).protocol!=='https:')return {ok:false,reason:'Media requires a public HTTPS URL'};
  const res=await httpFetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(res.status!==200)return {ok:false,reason:`Media URL returned HTTP ${res.status}; expected 200 without redirect`};
  const contentType=typeof res.headers?.get==='function'?res.headers.get('content-type'):res.headers?.['content-type'];
  if(!/^image\/(png|jpeg)(;|$)/i.test(contentType || ''))return {ok:false,reason:`Media URL returned Content-Type "${contentType || '(none)'}"`};
  const parts=[];let size=0;
  if(res.body?.getReader) {
   const reader=res.body.getReader();
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();throw Error('Media exceeds 5 MB');}parts.push(Buffer.from(value));}
  } else {parts.push(Buffer.from(await res.arrayBuffer()));}
  const buffer=Buffer.concat(parts);
  if(!buffer.length || buffer.length>MAX_BYTES)throw Error('Empty or oversized media');
  const sharp=require('sharp');const image=sharp(buffer,{limitInputPixels:16000000,failOn:'warning'});
  const meta=await image.metadata();
  if(!['jpeg','png'].includes(meta.format))throw Error('Media is not PNG or JPEG');
  if((meta.format==='jpeg' && !/^image\/jpeg/i.test(contentType)) || (meta.format==='png' && !/^image\/png/i.test(contentType)))throw Error('Media type disagrees with decoded image');
  await image.raw().toBuffer(); // Detect truncated/corrupt files, including after the header.
  return {ok:true,contentType,byteLength:buffer.length,width:meta.width,height:meta.height};
 }catch(error){return {ok:false,reason:`Media validation failed: ${error.message}`};}
}
module.exports={preflightCheckMedia,PNG_SIGNATURE};
