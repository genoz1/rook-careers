const assert = require('node:assert/strict');
const { test } = require('node:test');
const { selectedPublicQueries, fetchPublicLinkedInSignals, discoverPublicJobSignals } = require('./discovery/publicJobSignals');
const { run } = require('./runPublicJobDiscovery');

test('public query rotation is bounded and covers all requested sales markets', () => {
  const queries = selectedPublicQueries(new Date('2026-10-06T12:00:00Z'), 6);
  assert.equal(queries.length, 6);
  assert.match(queries.map((item) => item.query).join(' '), /medical device.*diagnostics.*pharmaceutical.*veterinary.*animal health/i);
});

test('public LinkedIn HTML yields employer signals without authentication', async () => {
  const html = `<li><div class="base-search-card" data-entity-urn="urn:li:jobPosting:123"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/123"></a><h3 class="base-search-card__title">Territory Sales Manager</h3><h4 class="base-search-card__subtitle"><a>Acme Medical</a></h4></div></li>`;
  const signals = await fetchPublicLinkedInSignals({ query: 'medical device sales', industry: 'Medical Device' }, {
    httpFetch: async () => ({ ok: true, text: async () => html }),
  });
  assert.deepEqual(signals[0], { companyName: 'Acme Medical', title: 'Territory Sales Manager', jobUrl: 'https://www.linkedin.com/jobs/view/123', sourceId: '123', industry: 'Medical Device', query: 'medical device sales', signalSource: 'linkedin-public-jobs' });
});

test('known employers and duplicate signals are removed before official-site enrichment', async () => {
  let resolutions = 0;
  const result = await discoverPublicJobSignals({
    queryLimit: 1, signalLimit: 5, knownEmployers: [{ company_name: 'Known Medical' }],
    fetchLinkedIn: async () => [
      { companyName: 'Known Medical', title: 'Territory Sales Manager', signalSource: 'linkedin-public-jobs' },
      { companyName: 'New Diagnostics', title: 'Diagnostics Sales Executive', signalSource: 'linkedin-public-jobs' },
      { companyName: 'New Diagnostics Inc.', title: 'Laboratory Sales Manager', signalSource: 'linkedin-public-jobs' },
    ],
    fetchJobicy: async () => [],
    resolveWebsite: async () => { resolutions++; return { website: 'https://newdiagnostics.example/' }; },
  });
  assert.equal(result.stats.already_monitored, 1);
  assert.equal(result.stats.genuinely_new, 1);
  assert.equal(result.stats.duplicate_companies, 1);
  assert.equal(resolutions, 1);
  assert.equal(result.signals[0].company_website, 'https://newdiagnostics.example/');
});

test('shadow mode is read-only and reports Phase 2 inspection', async () => {
  const summary = await run(['--shadow', '--limit', '2', '--query-limit', '1'], {
    store: { listEmployers: async () => [] },
    discoverSignals: async () => ({ stats: { genuinely_new: 1 }, signals: [{ company_name: 'Acme', company_website: 'https://acme.example' }] }),
    resolveSource: async () => ({ official_url: 'https://acme.example/', careers_pages: ['https://acme.example/careers'], configurations: [{ ats_type: 'greenhouse', ats_identifier: 'acme' }] }),
    validate: async () => ({ ok: true, status: 'PASS_VALIDATED_SOURCE', plausible_job_count: 2 }),
  });
  assert.equal(summary.companies_machine_validated, 1);
  assert.equal(summary.validated_relevant_jobs, 2);
});

test('apply mode counts a valid source with no relevant jobs as machine validated', async () => {
  const summary = await run(['--apply', '--limit', '1', '--query-limit', '1'], {
    store: { listEmployers: async () => [] },
    discoverSignals: async () => ({ stats: {}, signals: [{ company_name: 'Acme' }] }),
    pipeline: { processSignal: async () => ({
      status: 'enrolled',
      candidate: { id: 'candidate-1' },
      employer: { id: 'employer-1', ats_type: 'custom_html' },
      validation: { status: 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS', plausible_job_count: 0 },
    }) },
  });
  assert.equal(summary.companies_machine_validated, 1);
  assert.equal(summary.automatically_enrolled, 1);
});
