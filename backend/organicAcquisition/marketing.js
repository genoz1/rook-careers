'use strict';
// Reviewed editorial reserve: no runtime model calls, invented vacancies or job records.
const {digest}=require('./security');
const ORIGIN='https://rookcareers.com';
const VERSION=2;
const MIX={opportunities:30,advice:25,benefits:20,preparation:15,insights:10};
const CYCLE=['opportunities','advice','benefits','preparation','opportunities','insights','advice','benefits','opportunities','preparation','advice','opportunities','benefits','insights','advice','opportunities','preparation','benefits','advice','opportunities'];
const sectors=[
 ['florida','Florida medical sales','medical-sales-jobs/florida','Your next move in Florida','Looking for a medical sales position in Florida?','Explore Florida medical sales opportunities.'],
 ['device','medical device sales','medical-device-sales-jobs','Find your next device sales role','Ready for your next move in medical device sales?','Explore medical device sales opportunities.'],
 ['diagnostics','diagnostics sales','diagnostics-sales-jobs','Discover diagnostics careers','Know your way around a laboratory sales conversation?','Find your next diagnostics sales role.'],
 ['pharma','pharmaceutical sales','pharmaceutical-sales-jobs','Explore pharmaceutical sales','Considering a new pharmaceutical sales territory?','Explore pharmaceutical sales opportunities.'],
 ['animal-health','veterinary and animal health sales','veterinary-sales-jobs','Your next animal-health role','Looking for your next opportunity in animal health sales?','Discover veterinary and animal health sales opportunities.'],
 ['medical','medical sales','medical-sales-jobs','A smarter medical sales search','Your next medical sales opportunity may start on a company career site.','Explore employer-direct medical sales opportunities.'],
];
const guide=(slug)=>'/resources/'+slug+'/';
const templates=[];
function add(id,category,headline,hook,body,cta,path,{format='link',sector=null}={}){
 templates.push({id,category,headline,hook,body,cta,path,format,sector});
}
for(const [id,label,path,headline,hook,cta] of sectors){
 const detail={florida:'Whether you are considering devices, diagnostics or pharmaceuticals, bring your Florida search into one place instead of checking individual company websites. Review each role’s location and territory before applying.',device:'Put your device sales experience to work in your next search. Compare the products, customer setting and territory responsibilities in opportunities gathered from employer career sites.',diagnostics:'Laboratory services, testing products and instrumentation offer different commercial paths. Find relevant employer-direct opportunities on ROOK and focus on the kind of customer conversation you know best.',pharma:'A new therapeutic area or territory can mean a different next chapter. ROOK gathers pharmaceutical sales opportunities from company career sites so you can explore the roles that fit your background.','animal-health':'Your experience building relationships with veterinary practices can take more than one direction. Explore diagnostics, pharmaceuticals and other animal-health sales opportunities collected from employer career sites.',medical:'Find a focused starting point for your next move. ROOK brings medical and veterinary sales roles from employer career sites together, helping you compare career paths without sorting through unrelated clinical jobs.'}[id];
 add('opportunity-'+id,'opportunities',headline,hook,detail,cta,'/jobs/category/'+path,{sector:id,format:id==='florida'?'image':'link'});
 add('search-'+id,'opportunities',headline,'What is next for your '+label+' career?',detail+' Spend less time searching and more time considering a role that fits.',cta,'/jobs/category/'+path,{sector:id,format:'image'});
}
add('territory-questions','advice','Look beyond the job title','The territory matters as much as the title.','Before you apply, look at the customer mix, travel expectations and account responsibilities. Two medical sales roles with similar titles can offer very different day-to-day work.','Compare medical sales roles with a clearer checklist.',guide('how-to-build-a-30-60-90-day-territory-sales-plan'));
add('account-examples','advice','Make your experience specific','What does your best account win say about you?','Practice explaining the customer need, your own actions and the outcome you can support. A specific example tells a hiring manager more than a list of sales buzzwords.','Build stronger examples for your next conversation.',guide('medical-sales-interview-questions-what-to-expect-and-how-to-prepare'),{format:'image'});
add('device-training','advice','Ask about the ramp','Before accepting a device sales role, ask about the ramp.','Product training, field support and territory handoffs shape your first months. Ask how the team helps a new representative learn the product and develop accounts.','Know what to ask about a device sales role.',guide('what-associate-medical-device-sales-representatives-do'));
add('diagnostics-fit','advice','Find the right customer fit','Lab services or diagnostic instruments: which fits your experience?','The buying process, demonstrations and ongoing account support can differ. Compare the actual responsibilities before assuming two diagnostics roles are alike.','Explore the different paths in diagnostics sales.',guide('diagnostics-sales-careers-a-guide-to-laboratory-and-molecular-sales'));
add('animal-accounts','advice','Know the practice workflow','Animal health sales starts with understanding the practice.','Ask how the team supports product education, installation and service questions. Your account-development experience matters, and so does knowing when to bring in a specialist.','Get to know veterinary diagnostics sales.',guide('veterinary-diagnostics-sales-a-career-guide'),{format:'image'});
add('follow-through','advice','Make your follow-up useful','A good follow-up gives the conversation a next step.','After a medical sales interview, refer to a specific topic you discussed and explain how your experience connects. Keep it useful, concise and easy to respond to.','Prepare for your next medical sales interview.',guide('medical-sales-interview-questions-what-to-expect-and-how-to-prepare'));
add('fewer-tabs','benefits','Fewer tabs. More possibilities.','Your job search should not require dozens of open tabs.','ROOK brings medical and veterinary sales opportunities from employer career sites into one place. Explore the categories that fit your background, then choose membership to unlock full job details.','Spend less time searching company career sites.','/jobs/category/medical-sales-jobs',{format:'image'});
add('focused-search','benefits','Built for sales careers','Medical sales is a field of its own. Your job search should reflect that.','ROOK focuses on medical devices, diagnostics, pharmaceuticals and animal health sales. Find a starting point that fits your sales experience instead of sorting through unrelated clinical roles.','Discover a more focused career search.','/');
add('employer-direct','benefits','Start at the source','Want to find opportunities from the employers themselves?','ROOK gathers relevant medical and veterinary sales roles from employer career sites. Bring your search into one place and spend your time comparing the opportunities that interest you.','Explore employer-direct sales opportunities.','/jobs/category/medical-sales-jobs');
add('membership-value','benefits','Put your next move in focus','A more organized search starts with a focused source.','Browse protected ROOK previews to see whether the categories fit your next move. Membership unlocks employer names, full job descriptions and application information.','See how ROOK membership works.','/rook-pricing.html',{format:'image'});
add('sector-choice','benefits','Explore your next sales path','Your next step does not have to look exactly like your last role.','Explore medical device, laboratory, pharmaceutical and animal health sales on ROOK. Compare the customer settings and responsibilities before deciding where your experience fits.','Find a sales career path worth exploring.','/jobs/category/medical-sales-jobs');
add('resume-proof','preparation','Show what you did','Does your resume explain your impact, or just list your duties?','Describe the customer setting, what you did and an outcome you can support. Keep confidential account details out, and make it easy to see how your experience fits the role.','Strengthen your medical sales resume.',guide('how-to-write-a-medical-sales-resume'),{format:'image'});
add('interview-stories','preparation','Bring better interview examples','Three stories to prepare before your next medical sales interview.','Think through a new-business win, a difficult account and a setback. Be ready to explain your decisions, your contribution and what you learned.','Prepare examples that show how you sell.',guide('medical-sales-interview-questions-what-to-expect-and-how-to-prepare'));
add('transition-skills','preparation','Make your experience translate','Moving into a different medical sales sector? Make the connection clear.','Explain which account-development skills transfer and which product knowledge you still need to build. Honest, specific preparation is more useful than claiming experience you do not have.','Build a resume that supports your next move.',guide('how-to-write-a-medical-sales-resume'));
add('territory-interview','preparation','Build a practical territory plan','A territory plan is stronger when it starts with good questions.','Explain what you would learn, how you would prioritize accounts and how you would measure progress. Leave room for the employer’s training requirements and the actual sales cycle.','Prepare a practical territory plan.',guide('how-to-build-a-30-60-90-day-territory-sales-plan'),{format:'image'});
add('market-versus-opening','insights','Separate headlines from hiring','A product announcement is not the same as a job opening.','Industry news can help you prepare for a conversation. To find an actual opportunity, check the employer’s career listing and the role’s responsibilities. ROOK gathers those sales opportunities in one place.','Explore employer-direct medical sales opportunities.','/jobs/category/medical-sales-jobs');
add('buying-process','insights','Understand the buying process','The customer’s buying process changes the sales role.','Laboratory services, diagnostic equipment and device evaluations can involve different stakeholders and timelines. Learn the workflow behind a role before comparing it with your current position.','Understand the different paths in diagnostics sales.',guide('diagnostics-sales-careers-a-guide-to-laboratory-and-molecular-sales'),{format:'image'});
add('animal-channel','insights','Compare the route to market','Manufacturer or distributor? Look beyond the animal-health sales title.','The portfolio, customer group and channel responsibilities can change what the job involves. Ask how field representatives, technical teams and channel partners work together.','Explore how veterinary pharmaceutical sales works.',guide('veterinary-pharmaceutical-sales-what-the-role-involves'));
const catalog=Object.freeze(templates.map((t,i)=>Object.freeze({...t,design:i%3})));
function candidates(snapshot,now=Date.now()){
 const fresh=snapshot&&Number.isFinite(Date.parse(snapshot.capturedAt))&&now-Date.parse(snapshot.capturedAt)>=0&&now-Date.parse(snapshot.capturedAt)<86400000;
 return catalog.map(t=>{
  let body=t.body,observedAt=null,proof=null;
  if(t.id.startsWith('opportunity-')&&fresh){const sector=sectors.find(s=>s[0]===t.sector),cell=snapshot.collections?.find(c=>c.path==='/jobs/category/'+sector[2]&&!c.suppressed);
   if(cell&&Number.isInteger(cell.jobs)&&cell.jobs>0&&Number.isInteger(cell.representedEmployers)&&cell.representedEmployers>0){
    body=`ROOK currently tracks ${cell.jobs.toLocaleString('en-US')} ${sector[1]} opportunities from ${cell.representedEmployers.toLocaleString('en-US')} employers. Openings can change.\n\n${t.body}`;
    observedAt=snapshot.capturedAt;proof={path:cell.path,jobs:cell.jobs,employers:cell.representedEmployers,capturedAt:observedAt};
   }
  }
  const copy=[t.hook,body,t.cta].join('\n\n');return {...t,text:copy,url:ORIGIN+t.path,observedAt,proof,hash:digest(copy+'\n'+ORIGIN+t.path)};
 });
}
function words(text){return new Set(String(text).replace(/ROOK currently tracks[\s\S]*?Openings can change\./gi,'').toLowerCase().replace(/https?:\/\/\S+|#[a-z0-9]+/g,'').match(/[a-z]{3,}/g)?.filter(w=>!['the','and','your','you','for','with','from','that','this','rook','sales','medical'].includes(w))||[]);}
function similar(a,b){const x=words(a),y=words(b);if(!x.size||!y.size)return false;const same=[...x].filter(w=>y.has(w)).length;return same/Math.min(x.size,y.size)>.82||same/new Set([...x,...y]).size>.64;}
function validateCandidate(c,{now=Date.now(),recent=[]}={}){
 if(!catalog.some(t=>t.id===c.id)||!Object.hasOwn(MIX,c.category))throw Error('Unreviewed marketing template');
 if(typeof c.text!=='string'||c.text.length<180||c.text.length>1300||!c.cta||!c.text.endsWith(c.cta))throw Error('Marketing benefit or CTA missing');
 if(/represented employers|tracked inventory|employment snapshot|observed \d|guaranteed|hiring surge|whole market|free trial|100%|\$[\d,]+/i.test(c.text))throw Error('Marketing writing or claim rejected');
 if(/https?:\/\/|<[^>]+>|\b(?:apply_url|source_id|description_html)\b/i.test(c.text))throw Error('Unexpected link or protected fields');
 if(!c.hook||c.hook.length>120||!c.body||!c.headline||c.headline.length>70)throw Error('Marketing formatting rejected');
 const u=new URL(c.url);if(u.origin!==ORIGIN||u.search||u.hash||/^\/jobs\/(?!category\/)/.test(u.pathname))throw Error('Unsafe marketing destination');
 if(c.observedAt&&(now-Date.parse(c.observedAt)<0||now-Date.parse(c.observedAt)>86400000))throw Error('Marketing count is stale');
 if(c.proof&&!c.text.includes(c.proof.jobs.toLocaleString('en-US')))throw Error('Count provenance mismatch');
 if(recent.some(p=>similar(p.text||p.payload?.copy||'',c.text)))throw Error('Recent marketing copy is too similar');
 return c;
}
function weights(performance){
 const base={...MIX},rows=performance?.categories||[];
 if(performance?.paymentEvidence!=='stripe_verified'||rows.filter(r=>r.sessions>=100&&r.paidSubscriptions>=3).length<3||rows.reduce((s,r)=>s+r.paidSubscriptions,0)<25)return {mix:base,reason:'Keep the initial mix until enough Stripe-confirmed conversions exist.'};
 const reliable=rows.filter(r=>Object.hasOwn(base,r.category)&&r.sessions>=100&&r.paidSubscriptions>=3).sort((a,b)=>b.paidSubscriptions/b.sessions-a.paidSubscriptions/a.sessions);
 if(reliable.length<3)return {mix:base,reason:'Insufficient comparable conversion evidence.'};
 const high=reliable[0],low=reliable.at(-1);if(high.paidSubscriptions/high.sessions<1.5*low.paidSubscriptions/low.sessions)return {mix:base,reason:'Observed conversion difference is too small to change the mix.'};
 const shift=Math.min(5,base[low.category]-10,40-base[high.category]);base[high.category]+=shift;base[low.category]-=shift;
 return {mix:base,reason:'Small observational adjustment using Stripe-confirmed subscriber conversion; not evidence of causation.'};
}
function rank(pool,rows,channel,performance){
 const allHistory=rows.filter(r=>r.channel===channel&&r.payload?.qualityVersion===VERSION&&r.status!=='replaced'),history=allHistory.slice(0,20);
 const policy=weights(performance),preferred=CYCLE[allHistory.length%CYCLE.length];
 const counts=Object.fromEntries(Object.keys(MIX).map(k=>[k,history.filter(r=>r.payload.category===k).length]));
 const order=Object.keys(MIX).sort((a,b)=>(policy.mix[b]*(history.length+1)/100-counts[b])-(policy.mix[a]*(history.length+1)/100-counts[a]));
 if(policy.reason.startsWith('Keep'))order.splice(order.indexOf(preferred),1),order.unshift(preferred);
 return [...pool].sort((a,b)=>order.indexOf(a.category)-order.indexOf(b.category)||parseInt(digest(channel+history.length+a.id).slice(0,6),16)-parseInt(digest(channel+history.length+b.id).slice(0,6),16));
}
async function payloadFor(store,c,channel,id,now=Date.now()){
 validateCandidate(c,{now});if(!['linkedin','facebook'].includes(channel.service))throw Error('Company service required');
 const code=digest('marketing:'+id).slice(0,12),link=ORIGIN+'/s/'+(channel.service==='linkedin'?'li':'fb')+'/'+code;
 const target=new URL(c.url);target.searchParams.set('utm_source',channel.service);target.searchParams.set('utm_medium','organic_social');target.searchParams.set('utm_campaign','rook_'+c.category);target.searchParams.set('utm_content',c.id);target.searchParams.set('rook_post',id.slice(0,16));
 await store.call('put',{kind:'config',id:'marketing-link-'+code,body:{url:target.href,platform:channel.service,category:c.category,candidateId:c.id,postId:id.slice(0,16),createdAt:new Date(now).toISOString()}});
 const tags=c.sector==='florida'?'#MedicalSales #FloridaJobs':c.sector==='animal-health'||/veterinary|animal-health/.test(c.id)?'#VeterinarySales #AnimalHealthSales':c.sector==='device'?'#MedicalDeviceSales #MedicalSalesJobs':c.sector==='pharma'?'#PharmaceuticalSales #MedicalSales':c.sector==='diagnostics'?'#DiagnosticsSales #MedicalSalesJobs':channel.service==='linkedin'?'#MedicalSales #CareerGrowth':'#MedicalSalesJobs #SalesCareers';
 return {qualityVersion:VERSION,copy:c.text,text:c.text+'\n\n'+link+'\n\n'+tags,url:c.url,shortUrl:link,contentHash:c.hash,candidateId:c.id,category:c.category,observedAt:c.observedAt,proof:c.proof,creativeId:c.id,format:c.format,headline:c.headline,description:c.cta,imageUrl:ORIGIN+'/marketing/'+c.id+'.jpg'};
}
function validatePayload(payload,{snapshot,now=Date.now()}={}){
 if(payload.qualityVersion!==VERSION)throw Error('Marketing quality upgrade required');
 const c=candidates(payload.observedAt?snapshot:null,now).find(c=>c.id===payload.candidateId);if(!c||c.text!==payload.copy||c.hash!==payload.contentHash||c.url!==payload.url)throw Error('Marketing content changed or needs regeneration');
 validateCandidate(c,{now});if(payload.text.length>1700||!/^https:\/\/rookcareers\.com\/s\/(li|fb)\/[a-f0-9]{12}$/.test(payload.shortUrl)||!payload.text.includes(payload.shortUrl)||/[?&](?:utm_|rook_post)/.test(payload.text))throw Error('Marketing link presentation rejected');
 if(payload.imageUrl!==ORIGIN+'/marketing/'+c.id+'.jpg'||!['image','link'].includes(payload.format))throw Error('Marketing visual rejected');return true;
}
module.exports={ORIGIN,VERSION,MIX,CYCLE,catalog,candidates,similar,validateCandidate,validatePayload,weights,rank,payloadFor};
