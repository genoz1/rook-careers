// Public AEM careersearch contract used by the verified Novo Nordisk site.
const cheerio=require('cheerio');
const {getHtml,plain}=require('./htmlSource');
const {titleLooksRelevantWithDiagnostics: titleLooksRelevant}=require('../titleFilterDiagnostics');
async function fetchAemCareersJobs(identifier){
 const source=new URL(identifier),html=await getHtml(source.href),$=cheerio.load(html);
 const locale=$('html').attr('lang')||'en-US';
 const results=$('[name="jobResultPage"]').attr('value');
 if(!results)throw Error('AEM career search page missing verified results page');
 const resultUrl=new URL(results,source);if(resultUrl.origin!==source.origin)throw Error('Cross-origin AEM results page');
 const resultHtml=await getHtml(resultUrl.href),$$=cheerio.load(resultHtml),adPath=$$('[ref="jobAdUrl"]').attr('value');
 if(!adPath||!adPath.startsWith('/'))throw Error('AEM results page missing job detail path');
 const api=new URL('/bin/nncorp/careersearch',source);api.search=new URLSearchParams({keyword:'',country:'',category:'',locale});
 const res=await fetch(api,{signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error('AEM careersearch HTTP '+res.status);
 const data=(await res.json()).data;
 if(!Array.isArray(data?.jobs)||data.totalMatches!==data.jobs.length)throw Error('AEM incomplete or unrecognized job listing');
 const seen=new Set();for(const j of data.jobs){if(!j.jobId||!j.jobTitle||seen.has(j.jobId))throw Error('AEM malformed/repeated job');seen.add(j.jobId);}
 const jobs=[];jobs.incompleteSnapshot=false;jobs.snapshotWarnings=[];jobs.sourceListingCount=data.jobs.length;
 for(const row of data.jobs.filter(j=>titleLooksRelevant(j.jobTitle,j))){
  try{const url=new URL(adPath+'.'+encodeURIComponent(row.jobId)+'.html',source).href,detail=cheerio.load(await getHtml(url));
   if(plain(detail('#careerjobdisplay h1').text())!==plain(row.jobTitle))throw Error('AEM detail title mismatch');
   const description=detail('.job-display-details').html();if(!description||plain(description).length<80)throw Error('AEM missing full description');
   jobs.push({...row,url,description});
  }catch(e){jobs.incompleteSnapshot=true;jobs.snapshotWarnings.push(row.jobId+': '+e.message);}
 }
 return jobs;
}
function normalizeAemCareersJob(raw,employer){return {
 source_job_id:raw.jobId,source_type:'career_site',source_url:raw.url,application_url:raw.url,
 employer_id:employer.id,company_name:employer.company_name,title_original:raw.jobTitle,
 description_html:raw.description,description_text:plain(raw.description),
 location_raw:[raw.jobCity?.label,raw.jobState?.label,raw.jobCountry?.label].filter(Boolean).join(', ')||raw.jobLocationLabel,
 date_posted:null,status:'active',source_verified:true
};}
module.exports={fetchAemCareersJobs,normalizeAemCareersJob};
