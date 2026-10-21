'use strict';
// Coordinate with the existing ROOK publisher without modifying its records or schedules.
function contentPath(url){
 try{const u=new URL(url);if(u.origin!=='https://rookcareers.com')return null;const m=u.pathname.match(/^\/go\/[^/]+\/resources\/([a-z0-9-]+)\/?$/);return m?'/resources/'+m[1]:u.pathname.replace(/\/$/,'');}catch{return null;}
}
function repeatsContent(post,url){const target=contentPath(url);return !!target&&(String(post.text||'').match(/https:\/\/rookcareers\.com\/[^\s<>"']+/g)||[]).some(link=>contentPath(link.replace(/[.,;)]*$/,''))===target);}
function nearSlot(post,channel,when,gapMinutes=60){const time=Date.parse(post.sentAt||post.dueAt);return post.channelId===channel&&Number.isFinite(time)&&Math.abs(time-when)<gapMinutes*60000;}
module.exports={contentPath,repeatsContent,nearSlot};
