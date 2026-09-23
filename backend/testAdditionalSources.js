const {test}=require('node:test');const assert=require('node:assert/strict');
const {fetchUnifiedJobs}=require('./adapters/successfactorsUnified');
const {fetchAemCareersJobs}=require('./adapters/aemcareers');
test('SuccessFactors unified pagination deduplicates and preserves jobs on inconsistent counts',async()=>{
 const old=global.fetch;global.fetch=async(url,options)=>{
  if(String(url).includes('/services/')){const page=JSON.parse(options.body).pageNumber;return {ok:true,json:async()=>({totalJobs:3,jobSearchResult:(page===0?[1,2]:[2]).map(id=>({response:{id:String(id),unifiedStandardTitle:'Territory Sales Manager',jobLocationCountry:['United States']}}))})};}
  return {ok:true,headers:new Headers(),text:async()=>'<div itemtype="http://schema.org/JobPosting"><span itemprop="description">Sell medical devices to clinical customers across the territory. Build customer relationships and account plans.</span></div>'};
 };
 try{const jobs=await fetchUnifiedJobs('https://careers.example.com');assert.equal(jobs.length,2);assert.equal(jobs.incompleteSnapshot,true);assert.match(jobs[0].location,/United States/);}finally{global.fetch=old}
});
test('AEM missing source count fails before any detail is treated as a job',async()=>{
 const old=global.fetch;global.fetch=async url=>({ok:true,headers:new Headers(),text:async()=>String(url).includes('results')?'<input ref="jobAdUrl" value="/job-ad">':'<html lang="en-US"><input name="jobResultPage" value="/results"></html>',json:async()=>({data:{totalMatches:10,jobs:[]}})});
 try{await assert.rejects(fetchAemCareersJobs('https://careers.example.com/search'),/incomplete/);}finally{global.fetch=old}
});
