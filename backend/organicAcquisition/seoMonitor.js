'use strict';
const {guides}=require('../organicGuidance');
const {digest}=require('./security');
const {ORIGIN}=require('./content');
async function auditPublicResources({httpFetch=fetch,now=Date.now()}={}){
 const pages=[],seen=new Map();
 for(const slug of Object.keys(guides)){
  const url=ORIGIN+'/resources/'+slug+'/';
  try{
   const r=await httpFetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000)});
   const html=await r.text();if(html.length>1500000)throw Error('oversized');const $=require('cheerio').load(html);
   const canonical=$('link[rel="canonical"]').attr('href'),title=$('title').text(),modified=$('meta[property="article:modified_time"]').attr('content');
   $('nav,footer,script,style').remove();const text=$('.prose').text().replace(/\s+/g,' ').trim(),hash=digest(text);
   const problems=[];if(r.status!==200)problems.push('http_'+r.status);if(canonical?.replace(/\/$/,'')!==url.replace(/\/$/,''))problems.push('canonical_mismatch');if(!title||!$('h1').length)problems.push('missing_metadata');if(text.length<300)problems.push('thin_or_unavailable_content');
   if(text&&seen.has(hash))problems.push('duplicate_of_'+seen.get(hash));else if(text)seen.set(hash,slug);
   if(modified&&now-Date.parse(modified)>180*86400000)problems.push('editorial_review_due_not_automatically_outdated');
   pages.push({slug,status:r.status,canonical,contentHash:hash,problems});
  }catch{pages.push({slug,problems:['temporarily_unavailable_retry_next_cycle']});}
 }return {capturedAt:new Date(now).toISOString(),pages,note:'Detects issues only; never deletes articles or changes protected jobs. Article age alone is not evidence of factual inaccuracy.'};
}
module.exports={auditPublicResources};
