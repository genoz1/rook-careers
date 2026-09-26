const cheerio = require('cheerio');
const { getHtml, jobPosting, detailFields, plain } = require('./htmlSource');
const { titleLooksRelevantWithDiagnostics: titleLooksRelevant } = require('../titleFilterDiagnostics');
// Read JSON data from the public Next server response; never execute scripts.
function listingData(html) {
  const $ = cheerio.load(html); let stream = '';
  for (const el of $('script').toArray()) {
    const text = $(el).text().trim();
    if (!text.startsWith('self.__next_f.push(') || !text.endsWith(')')) continue;
    try { const chunk = JSON.parse(text.slice(19,-1)); if(chunk[0]===1 && typeof chunk[1]==='string') stream += chunk[1]; } catch {}
  }
  const marker = '"jobs":['; const start = stream.indexOf(marker);
  if(start<0) throw Error('Kula listing data unavailable');
  const offset=start+marker.length-1; let depth=0, quoted=false, escape=false;
  for(let i=offset;i<stream.length;i++) {
    const c=stream[i];
    if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quoted=false;continue;}
    if(c==='"')quoted=true;
    else if(c==='[')depth++;
    else if(c===']'&&--depth===0)return JSON.parse(stream.slice(offset,i+1));
  }
  throw Error('Kula truncated listing data');
}
async function fetchKulaJobs(slug) {
  if(!/^[a-z0-9-]+$/i.test(slug)) throw Error('Invalid Kula employer slug');
  const base='https://careers.kula.ai/'+slug;
  const listed=listingData(await getHtml(base));
  const ids=new Set();
  for(const row of listed){if(!row.id || !row.title || ids.has(row.id))throw Error('Kula malformed or repeated job');ids.add(row.id);}
  const jobs=[];jobs.sourceListingCount=listed.length;jobs.incompleteSnapshot=false;jobs.snapshotWarnings=[];
  for(const row of listed.filter(j=>j.listed===true && !j.is_confidential && titleLooksRelevant(j.title,j))) {
    try {
      const url=base+'/'+row.id, html=await getHtml(url), ld=jobPosting(html);
      if(!ld || !ld.description || plain(ld.title)!==plain(row.title))throw Error('Kula detail identity or description unavailable');
      jobs.push({...row,url,fields:detailFields(html,'main','[itemprop="jobLocation"]')});
    } catch(e){jobs.incompleteSnapshot=true;jobs.snapshotWarnings.push(row.id+': '+e.message);}
  }
  return jobs;
}
function normalizeKulaJob(raw,employer){return {
  source_job_id:String(raw.id),employer_id:employer.id,company_name:employer.company_name,
  source_type:'career_site',source_url:raw.url,application_url:raw.url,title_original:raw.title,
  description_html:raw.fields.description,description_text:plain(raw.fields.description),
  location_raw:raw.fields.location || (raw.ats_job?.offices||[]).map(o=>[o.city,o.state,o.country].filter(Boolean).join(', ')).join(' | '),
  date_posted:raw.fields.date?.slice(0,10)||null,status:'active',source_verified:true
};}
module.exports={fetchKulaJobs,normalizeKulaJob,listingData};
