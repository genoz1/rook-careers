const {test}=require('node:test');const assert=require('node:assert/strict');
const {analysisPatch}=require('./scripts/repairIngestionDataQuality');
test('classification backfill preserves recognized good categories and other analysis',()=>{
 const job={title_original:'Territory Sales Manager',description_text:'We sell medical devices and catheters.',ai_analysis:{product_categories:['Diagnostics'],seniority_level:'Director'}};
 assert.equal(analysisPatch(job,{}),null);
 job.ai_analysis={seniority_level:'Director',product_categories:[]};
 const patch=analysisPatch(job,{});assert.equal(patch.ai_analysis.seniority_level,'Director');assert.deepEqual(patch.ai_analysis.product_categories,['Medical Device']);
});
test('benefits do not create Dental and verified Foundation metadata can fill missing labels',()=>{
 const job={title_original:'Account Executive',description_text:'Benefits: medical and dental insurance.',ai_analysis:{product_categories:[]}};
 assert.equal(analysisPatch(job,{}),null);
 assert.deepEqual(analysisPatch(job,{industry:'Diagnostics'}).ai_analysis.product_categories,['Diagnostics']);
});
