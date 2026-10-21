// Read-only: request existing public collections; retain ONLY aggregate counts.
// No credentials, row data, database calls, publishing, or scheduler registration.
const fs=require('node:fs');
const {CATEGORIES,FLORIDA}=require('../backend/seoInventory');
async function collect(fetcher=fetch){
 const capturedAt=new Date().toISOString(),collections=[];
 for(const slug of Object.keys(CATEGORIES))for(const florida of [false,true]){
  if(florida&&!FLORIDA.includes(slug))continue;
  const path='/jobs/category/'+slug+(florida?'/florida':'');
  const response=await fetcher('https://rookcareers.com'+path,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Collection unavailable: '+path+' ('+response.status+')');
  const html=await response.text();
  const count=html.match(/data-job-count="(\d+)"/),employers=html.match(/data-company-count="(\d+)"/);
  if(!count||!employers||!html.includes('rel="canonical" href="https://rookcareers.com'+path+'"'))throw Error('Unverified collection: '+path);
  const jobs=Number(count[1]),representedEmployers=Number(employers[1]);
  // Never emit small cells or job identifiers. Do not add cross-tabs or subtraction cells.
  collections.push({path,label:CATEGORIES[slug].label+(florida?' in Florida':''),...(jobs>=20&&representedEmployers>=3?{jobs,representedEmployers}:{suppressed:true})});
 }
 return {schemaVersion:1,capturedAt,source:'Existing public ROOK collection counts; not independently verified against every employer',methodology:'active-approved-US-eligible-deduplicated-collections-v1',periodType:'point-in-time',historicalComparison:null,collections};
}
if(require.main===module){const out=process.argv[2];if(!out)throw Error('Supply an output JSON path');collect().then(d=>fs.writeFileSync(out,JSON.stringify(d,null,2)+'\n')).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={collect};
