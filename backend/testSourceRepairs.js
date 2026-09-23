const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchListings, detailFields } = require('./adapters/htmlSource');
const { parseBoardData } = require('./adapters/paylocity');
async function mock(pages, action) {
 const original=global.fetch;
 global.fetch=async url=>{if(!(url in pages))throw Error('Unexpected URL '+url);return new Response(pages[url]??'unavailable',{status:pages[url]===null?503:200});};
 try{return await action();}finally{global.fetch=original;}
}
const detail='<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',description:'<p>Sell diagnostic tests.</p>',jobLocation:{address:{addressLocality:'Boston',addressRegion:'MA',addressCountry:'US'}}})+'</script>';
const identify=u=>u.pathname.match(/^\/jobs\/(\d+)\//)?.[1];
test('nested relative anchors paginate and deduplicate',async()=>{
 await mock({
 'https://example.test/jobs':'<a href="/jobs/1/sales"><span>Sales Representative</span></a><a href="/jobs?p=2">Next page of results</a>',
 'https://example.test/jobs?p=2':'<a href="/jobs/1/sales">Sales Representative</a><a href="/jobs/2/sales">Territory Manager</a>',
 'https://example.test/jobs/1/sales':detail,'https://example.test/jobs/2/sales':detail},async()=>{
 const rows=await fetchListings('https://example.test/jobs',identify);
 assert.equal(rows.length,2);assert.equal(rows.incompleteSnapshot,false);
 assert.equal(detailFields(rows[0].detailHtml,'.description','.location').location,'Boston, MA, US');
 });
});
test('failed detail and pagination prohibit closures',async()=>{
 await mock({'https://example.test/jobs':'<a href="/jobs/1/sales">Sales Representative</a><a href="/jobs?p=2">Next</a>','https://example.test/jobs?p=2':null,'https://example.test/jobs/1/sales':null},async()=>{
 const rows=await fetchListings('https://example.test/jobs',identify);
 assert.equal(rows.length,0);assert.equal(rows.incompleteSnapshot,true);
 });
});
test('HTTP 200 login cannot certify empty',async()=>{
 await mock({'https://example.test/jobs':'<h1>Sign in</h1>'},async()=>assert.rejects(fetchListings('https://example.test/jobs',identify),/without recognized jobs/));
});
test('explicit empty source is allowed',async()=>{
 await mock({'https://example.test/jobs':'<h1>No open positions</h1>'},async()=>{
 const rows=await fetchListings('https://example.test/jobs',identify);assert.equal(rows.length,0);assert.equal(rows.incompleteSnapshot,false);
 });
});
test('Paylocity board data parsed, not executed',()=>{
 assert.equal(parseBoardData('<script>window.pageData = {"ModuleTitle":"Employer","Jobs":[{"JobId":1}]};</script>').Jobs.length,1);
 assert.throws(()=>parseBoardData('<script>window.pageData = {"Jobs":[]};</script>'),/schema/);
 assert.throws(()=>parseBoardData('<script>window.pageData = runCode();</script>'),/unavailable/);
});
test('ADP HTML fails visibly instead of healthy zero',async()=>{
 await mock({'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=19000101_000001&cid=example&lang=en_US&type=2&v=1&count=25&offset=0':'<html>careers</html>'},async()=>{
 await assert.rejects(require('./adapters/adp').fetchAdpJobs({ats_identifier:'example',company_name:'Employer'}));
 });
});
