'use strict';
const {digest}=require('./security');
const SEEDS=[
 {url:'https://www.medicalsalescollege.com/',type:'training'},
 {url:'https://evolveyoursuccess.com/',type:'career coaching'},
 {url:'https://repertoiremag.com/',type:'medical sales publication'},
 {url:'https://vet-advantage.com/',type:'animal health sales publication'},
 {url:'https://www.hida.org/',type:'medical distribution association'},
 {url:'https://www.bioflorida.com/',type:'Florida life sciences association'},
 {url:'https://www.massdevice.com/',type:'medical device publication'},
 {url:'https://www.biospace.com/',type:'life sciences careers'},
 {url:'https://todaysveterinarybusiness.com/',type:'veterinary business publication'},
 {url:'https://www.labmanager.com/',type:'laboratory publication'},
];
async function robotsAllowed(url,httpFetch){
 const u=new URL(url);const r=await httpFetch(u.origin+'/robots.txt',{redirect:'manual',signal:AbortSignal.timeout(8000)});
 if(r.status===404)return true;if(!r.ok)return false;
 const text=await r.text();if(text.length>100000)return false;
 let agents=[],rules=[],groups=[],inRules=false;
 for(const line of text.split(/\r?\n/)){
  const match=line.replace(/#.*/,'').match(/^\s*(user-agent|disallow|allow)\s*:\s*(.*?)\s*$/i);if(!match)continue;
  const field=match[1].toLowerCase(),value=match[2];
  if(field==='user-agent'){if(inRules){groups.push({agents,rules});agents=[];rules=[];inRules=false;}agents.push(value.toLowerCase());}
  else{inRules=true;if(value)rules.push({allow:field==='allow',value});}
 }groups.push({agents,rules});
 const matches=groups.filter(g=>g.agents.some(a=>a==='*'||'rookcareerspartnerresearch'.includes(a))).flatMap(g=>g.rules).filter(rule=>{const pattern=rule.value.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\\\$$/,'$');try{return new RegExp('^'+pattern).test(u.pathname);}catch{return false;}}).sort((a,b)=>b.value.length-a.value.length||Number(b.allow)-Number(a.allow));
 return !matches.length||matches[0].allow;
}
async function discover(store,{httpFetch=fetch,now=Date.now()}={}){
 let qualified=0,failed=0;
 // Bounded known official sources. Discovery NEVER implies permission to email.
 for(const seed of SEEDS){
  const id=digest(new URL(seed.url).hostname.replace(/^www\./,''));
  const old=await store.call('get',{kind:'prospect',id});
  if(old&&now-Date.parse(old.checkedAt)<(old.verificationStatus?86400000:7*86400000))continue;
  try{
   if(!await robotsAllowed(seed.url,httpFetch))throw Error('crawler_not_permitted');
   const response=await httpFetch(seed.url,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'User-Agent':'ROOKCareersPartnerResearch/1.0 (+https://rookcareers.com/partners/)'}});
   if(!response.ok)throw Error('unavailable');
   const raw=await response.text();if(raw.length>2000000)throw Error('oversized');
   const $=require('cheerio').load(raw);$('script,style,nav,footer').remove();const text=$('body').text().replace(/\s+/g,' ').slice(0,50000);
   const relevant=/medical sales|medical device|animal health|veterinary|pharmaceutical|laboratory|life sciences/i.test(text);
   const audience=/career|sales|training|newsletter|association|professional|business/i.test(text);
   const body={url:seed.url,type:seed.type,qualified:relevant&&audience,score:Number(relevant)+Number(audience),checkedAt:new Date(now).toISOString(),outreachStatus:'permission_required',invitation:'ROOK offers a $5 one-time commission for each verified new paying monthly subscriber. Interested partners can review the program and opt in at https://rookcareers.com/partners/. No protected individual job information is shared.',followupStatus:'not_enrolled_no_send'};
   // Do not retain copied article text, scraped personal addresses or profile data.
   await store.call('put',{kind:'prospect',id,body});if(body.qualified)qualified++;
   // Discover relevant organizations linked by known public sources. Store only the
   // organization URL and source evidence; never fetch arbitrary targets or scrape inboxes.
   let discovered=0;
   for(const el of $('a[href]').toArray()){
    if(discovered>=5)break;
    const anchor=$(el).text().replace(/\s+/g,' ').trim();
    if(!/medical sales|sales coach|resume|interview|career training|veterinary sales|animal health sales/i.test(anchor))continue;
    let target;try{target=new URL($(el).attr('href'),seed.url);}catch{continue;}
    if(target.protocol!=='https:'||target.username||target.password||!target.hostname.includes('.')||/^([\d.]+|localhost)$/.test(target.hostname)||/facebook\.com|linkedin\.com|reddit\.com|twitter\.com|x\.com$/i.test(target.hostname)||target.hostname===new URL(seed.url).hostname)continue;
    const candidateId=digest(target.hostname.replace(/^www\./,''));
    if(await store.call('get',{kind:'prospect',id:candidateId}))continue;
    await store.call('put',{kind:'prospect',id:candidateId,body:{url:target.origin+'/',sourceUrl:seed.url,type:'publicly referenced career organization',qualified:false,score:1,checkedAt:new Date(now).toISOString(),outreachStatus:'permission_required',followupStatus:'not_enrolled_no_send',needsDomainVerification:true}});discovered++;
   }
  }catch{failed++;await store.call('put',{kind:'prospect',id,body:{url:seed.url,type:seed.type,qualified:false,checkedAt:new Date(now).toISOString(),verificationStatus:'temporarily_unavailable_or_not_permitted',outreachStatus:'permission_required',followupStatus:'not_enrolled_no_send'}});}
 }return {qualified,failed};
}
async function schedulePartnerMessages(store,{now=Date.now(),postalAddress,followupsEnabled=false}){
 if(!postalAddress)return {queued:0,blocked:'verified_postal_address_required'};
 let queued=0;
 for(const {id,body:p} of await store.call('list',{kind:'partner'})){
  if(p.status!=='active'||!p.marketingConsent||!p.emailVerified)continue;
  if(await store.call('get',{kind:'suppression',id:p.identityHash}))continue;
  for(const [stage,delay] of (followupsEnabled?[['welcome',0],['helpful-followup',7*86400000]]:[['welcome',0]])){
   if(now-Date.parse(p.createdAt)<delay)continue;
   await store.call('enqueue',{id:digest('partner:'+id+':'+stage),lane:'permissioned_email',channel:id,payload:{partnerId:id,stage},dueAt:new Date(now).toISOString()});queued++;
  }
 }return {queued};
}
module.exports={SEEDS,discover,schedulePartnerMessages,robotsAllowed};
