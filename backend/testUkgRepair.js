const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchUkgJobs, detailData } = require('./adapters/ukg');
const employer = { id: 'example', company_name: 'Example', ats_identifier: 'recruiting.ultipro.com|EXAMPLE|1234-abcd' };
const base = 'https://recruiting.ultipro.com/EXAMPLE/JobBoard/1234-abcd';
const config = '<script>var config={loadUrl:"/EXAMPLE/JobBoard/1234-abcd/JobBoardView/LoadSearchResults", opportunityLinkUrl:"/EXAMPLE/JobBoard/1234-abcd/OpportunityDetail?opportunityId=0000"}</script>';
const detail = id => 'new US.Opportunity.CandidateOpportunityDetail(' + JSON.stringify({ Id: id, Title: 'Account Executive', Description: '<p>Sell diagnostics {with full training}.</p>', Locations: [{ Address: { City: 'Boston', State: { Code: 'MA' }, Country: { Name: 'United States' } } }] }) + ');';
test('UKG uses the actual public search contract, paginates, and reads full details', async () => {
  const real = global.fetch; const offsets = [];
  global.fetch = async (url, options = {}) => {
    if (url === base) return new Response(config);
    if (url.includes('LoadSearchResults')) {
      const skip = JSON.parse(options.body).opportunitySearch.Skip; offsets.push(skip);
      return new Response(JSON.stringify({ totalCount: 2, opportunities: [{ Id: skip ? 'b' : 'a', Title: 'Account Executive' }] }));
    }
    return new Response(detail(new URL(url).searchParams.get('opportunityId')));
  };
  try {
    const jobs = await fetchUkgJobs(employer);
    assert.deepEqual(offsets, [0, 50]); assert.equal(jobs.length, 2); assert.equal(jobs.incompleteSnapshot, false);
    assert.equal(jobs[0].source_job_id, 'ukg-1234-abcd-a');
    assert.equal(jobs[0].location_raw, 'Boston, MA, United States');
    assert(jobs[0].description_text.includes('{with full training}'));
  } finally { global.fetch = real; }
});
test('UKG failed pagination preserves a partial snapshot instead of certifying completeness', async () => {
  const real = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (url === base) return new Response(config);
    if (url.includes('LoadSearchResults')) return JSON.parse(options.body).opportunitySearch.Skip ?
      new Response('unavailable', { status: 503 }) : new Response(JSON.stringify({ totalCount: 2, opportunities: [{ Id: 'a', Title: 'Account Executive' }] }));
    return new Response(detail('a'));
  };
  try { const jobs = await fetchUkgJobs(employer); assert.equal(jobs.length, 1); assert.equal(jobs.incompleteSnapshot, true); }
  finally { global.fetch = real; }
});
test('UKG embedded detail parser never executes JavaScript', () => {
  assert.equal(detailData(detail('abc')).Id, 'abc');
  assert.throws(() => detailData('new US.Opportunity.CandidateOpportunityDetail(runSomething());'));
  assert.throws(() => detailData('<h1>Login</h1>'));
});
