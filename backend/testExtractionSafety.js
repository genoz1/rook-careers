const { test } = require('node:test');
const assert = require('node:assert/strict');
const sf = require('./adapters/successfactors');
const wd = require('./adapters/workday');
const oracle = require('./adapters/oraclehcm');
const phenom = require('./adapters/phenom');
const gh = require('./adapters/greenhouse');
const pp = require('./adapters/pinpoint');
const json = data => ({ok:true,json:async()=>data});
const html = data => ({ok:true,text:async()=>data});
const fail = {ok:false,status:503,statusText:'Unavailable',text:async()=>''};
async function fake(fetcher, fn) {const old=global.fetch;global.fetch=fetcher;try{await fn();}finally{global.fetch=old;}}
function page(n,next=true){return `<a href="/job/Boston-Sales-MA-02108/${n+100}/">Territory Sales Manager</a>${next?`<a rel="next" href="/search/?q=sales&startrow=${n+1}">Next</a>`:''}`;}
for(const mode of ['http','network','malformed']) test(`SuccessFactors later ${mode} failure rejects the whole snapshot`,async()=>fake(async url=>{
 if(String(url).includes('startrow')) {if(mode==='network')throw Error('network');return mode==='http'?fail:html('<body>Access denied</body>');}
 return html(page(0));
},()=>assert.rejects(sf.fetchSuccessFactorsJobs('test.invalid'))));
test('SuccessFactors completes twelve pages beyond old ten-page cap',async()=>fake(async url=>String(url).includes('/job/')?html('<main>Description</main>'):html(page(Number(new URL(url).searchParams.get('startrow')||0),Number(new URL(url).searchParams.get('startrow')||0)<11)),async()=>assert.equal((await sf.fetchSuccessFactorsJobs('test.invalid')).length,12)));
test('SuccessFactors defensive cap rejects rather than returning rows',async()=>fake(async()=>html(page(0)),()=>assert.rejects(sf.fetchSuccessFactorsJobs('test.invalid',{maxPages:1}),/safety limit/)));
test('SuccessFactors cycle rejects rather than returning rows',async()=>fake(async url=>html(page(Number(new URL(url).searchParams.get('startrow')||0)).replace(/startrow=\d+/,'startrow=0')),()=>assert.rejects(sf.fetchSuccessFactorsJobs('test.invalid'),/no job rows|cycle/)));
test('SuccessFactors numeric pagination ignores previous pages',()=>{const $=require('cheerio').load('<a href="?q=sales&startrow=0">1</a><a href="?q=sales&startrow=50">3</a>');assert.equal(sf.findNextPageUrl($,'https://test.invalid/search/?q=sales&startrow=25'),'https://test.invalid/search/?q=sales&startrow=50');});
for(const [name,fetchJobs] of [['Greenhouse',()=>gh.fetchGreenhouseJobs('x')],['Pinpoint',()=>pp.fetchPinpointJobs('x')]]) {
 test(`${name} malformed body rejects`,async()=>fake(async()=>json({}),()=>assert.rejects(fetchJobs(),/malformed/)));
 test(`${name} explicit empty array succeeds`,async()=>fake(async()=>json(name==='Greenhouse'?{jobs:[]}:[]),async()=>assert.deepEqual(await fetchJobs(),[])));
 test(`${name} parser failure rejects`,async()=>fake(async()=>({ok:true,json:async()=>{throw Error('parser');}}),()=>assert.rejects(fetchJobs(),/parser/)));
}
for(const name of ['Workday','Oracle HCM']) {
 const isWd=name==='Workday';const run=()=>isWd?wd.fetchWorkdayJobs('x|wd1|site'):oracle.fetchOracleHcmJobs('test.invalid|site');
 const listing=(jobs,total)=>isWd?{jobPostings:jobs,total}:{items:[{requisitionList:jobs,TotalJobsCount:total}]};
 const job=i=>isWd?{title:'Sales Manager',externalPath:`/job/${i}`}:{Title:'Sales Manager',Id:i};
 for(const mode of ['http','network','malformed','empty'])test(`${name} later ${mode} page rejects`,async()=>{let calls=0;await fake(async()=>{if(++calls===1)return json(listing([job(1)],2));if(mode==='network')throw Error('network');return mode==='http'?fail:json(mode==='empty'?listing([],2):{});},()=>assert.rejects(run()));});
 for(const mode of ['http','network','malformed'])test(`${name} required detail ${mode} failure rejects`,async()=>{let calls=0;await fake(async()=>{if(++calls===1)return json(listing([job(1)],1));if(mode==='network')throw Error('network');return mode==='http'?fail:json({});},()=>assert.rejects(run()));});
 test(`${name} explicit zero succeeds`,async()=>fake(async()=>json(listing([],0)),async()=>assert.deepEqual(await run(),[])));
 test(`${name} complete paginated extraction succeeds`,async()=>{let count=0;await fake(async url=>{if(String(url).includes(isWd?'/jobs':'recruitingCEJobRequisitions?'))return json(listing([job(++count)],2));return json(isWd?{jobPostingInfo:{jobDescription:'sales'}}:{items:[{Id:1}]});},async()=>assert.equal((await run()).length,2));});
 test(`${name} safety limit rejects incomplete snapshot`,async()=>{let count=0;await fake(async()=>json(listing(Array.from({length:isWd?20:200},()=>({...(isWd?{title:'Engineer',externalPath:`/job/${++count}`}:{Title:'Engineer',Id:++count})})),10000)),()=>assert.rejects(run(),/safety limit/));});
}
for(const mode of ['http','network','malformed'])test(`Phenom later ${mode} page rejects`,async()=>{let count=0;await fake(async url=>{if(String(url).includes('search-results'))return html('"refNum":"X"');if(++count===1)return json({refineSearch:{data:{jobs:Array.from({length:20},(_,i)=>({id:i+1,title:'Sales Manager'}))}}});if(mode==='network')throw Error('network');return mode==='http'?fail:json({});},()=>assert.rejects(phenom.fetchPhenomJobs('test.invalid')));});
test('Phenom safety limit rejects unfinished snapshot',async()=>fake(async url=>String(url).includes('search-results')?html('"refNum":"X"'):json({refineSearch:{data:{jobs:Array.from({length:20},(_,i)=>({id:i+1,title:'Sales Manager'}))}}}),()=>assert.rejects(phenom.fetchPhenomJobs('test.invalid'),/safety limit/)));
test('Phenom explicit zero succeeds',async()=>fake(async url=>String(url).includes('search-results')?html('"refNum":"X"'):json({refineSearch:{data:{jobs:[]}}}),async()=>assert.deepEqual(await phenom.fetchPhenomJobs('test.invalid'),[])));
