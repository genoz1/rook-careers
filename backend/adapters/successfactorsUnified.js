const cheerio=require('cheerio');
const {titleLooksRelevant}=require('../relevanceFilter');
const {getHtml,detailFields,plain,jobPosting}=require('./htmlSource');
async function fetchUnifiedJobs(origin,locale='en_US') {
  const rows=[],seen=new Set();let received=0,complete=true;const warnings=[];
  for(let page=0;page<100;page++){
    try{
      const r=await fetch(origin+'/services/recruiting/v1/jobs',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:'sales',locale,location:'',pageNumber:page,sortBy:'recent'})});
      if(!r.ok)throw Error('SuccessFactors unified HTTP '+r.status);
      const data=await r.json();
      if(!Array.isArray(data.jobSearchResult)||!Number.isInteger(data.totalJobs))throw Error('SuccessFactors unified schema changed');
      for(const item of data.jobSearchResult){const j=item.response;if(!j?.id||!j.unifiedStandardTitle)throw Error('SuccessFactors unified malformed record');if(seen.has(j.id)){complete=false;warnings.push('Source repeated job '+j.id+' across pages');continue;}seen.add(j.id);rows.push(j);}
      received+=data.jobSearchResult.length;
      if(received>=data.totalJobs){if(rows.length!==data.totalJobs){complete=false;warnings.push('Unique job count differs from source total');}break;}
      if(!data.jobSearchResult.length||page===99)throw Error('SuccessFactors unified pagination incomplete');
    }catch(e){if(!rows.length)throw e;complete=false;warnings.push(e.message);break;}
  }
  const jobs=[];jobs.incompleteSnapshot=!complete;jobs.snapshotWarnings=warnings;jobs.sourceListingCount=rows.length;
  for(const row of rows.filter(j=>titleLooksRelevant(j.unifiedStandardTitle))){
    const url=origin+'/job/'+encodeURIComponent(row.unifiedStandardTitle)+'/'+row.id+'-'+locale;
    try{const html=await getHtml(url),ld=jobPosting(html),f=detailFields(html,'.jobdescription, #jobdescription, main','[itemprop="jobLocation"]'),$=cheerio.load(html);
      if(!f.description)f.description=$('[itemprop="description"]').toArray().map(e=>$(e).html()).join(' ');
      if((!ld&&!$('[itemtype="http://schema.org/JobPosting"]').length)||plain(f.description).length<80)throw Error('Unified detail lacks job description');
      jobs.push({title:row.unifiedStandardTitle,detailUrl:url,jobId:row.id,location:f.location||[...(row.jobLocationShort||[]).map(plain),...(row.jobLocationCountry||[])].join(' | '),description:plain(f.description),description_html:f.description,date:f.date});
    }catch(e){jobs.incompleteSnapshot=true;warnings.push(row.id+': '+e.message);}
  }
  return jobs;
}
module.exports={fetchUnifiedJobs};
