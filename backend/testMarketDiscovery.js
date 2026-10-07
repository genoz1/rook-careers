const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MARKET_QUERIES,
  selectedQueries,
  plausibleEmployerName,
  safeOfficialWebsite,
  websiteFromWikidata,
  nameDerivedDomains,
  websiteFromNameDerivedDomain,
  discoverMarketSignals,
} = require('./discovery/marketSignals');
const { parseArgs, run } = require('./runMarketDiscovery');

test('daily query rotation is deterministic, bounded, and covers the market vocabulary', () => {
  const first = selectedQueries(new Date('2026-10-06T12:00:00Z'), 4);
  const sameDay = selectedQueries(new Date('2026-10-06T23:59:00Z'), 4);
  const nextDay = selectedQueries(new Date('2026-10-07T00:01:00Z'), 4);
  assert.deepEqual(first, sameDay);
  assert.notDeepEqual(first, nextDay);
  assert.equal(first.length, 4);
  assert.match(MARKET_QUERIES.map((entry) => entry.query).join(' '), /medical device.*diagnostics.*pharmaceutical.*biotech.*veterinary.*animal health/i);
});

test('generic, confidential, and recruiting-company names are rejected', () => {
  assert.equal(plausibleEmployerName('Confidential'), false);
  assert.equal(plausibleEmployerName('Acme Staffing Solutions'), false);
  assert.equal(plausibleEmployerName('Acme Medical Devices'), true);
});

test('website safety accepts corporate sites and rejects aggregators, social sites, and ATS hosts', () => {
  assert.equal(safeOfficialWebsite('https://acme.example/about'), 'https://acme.example/about');
  assert.equal(safeOfficialWebsite('https://www.linkedin.com/company/acme'), null);
  assert.equal(safeOfficialWebsite('https://boards.greenhouse.io/acme'), null);
});

test('Wikidata website resolution requires an exact company label or alias', async () => {
  const responses = [
    { ok: true, json: async () => ({ search: [{ id: 'Q1', label: 'Acme Medical, Inc.', aliases: ['Acme Medical'] }, { id: 'Q2', label: 'Unrelated Acme' }] }) },
    { ok: true, json: async () => ({ entities: { Q1: { claims: { P856: [{ mainsnak: { datavalue: { value: 'https://acmemedical.example/' } } }] } } } }) },
  ];
  const result = await websiteFromWikidata('Acme Medical', { httpFetch: async () => responses.shift() });
  assert.deepEqual(result, { website: 'https://acmemedical.example/', entity_id: 'Q1', match: 'exact_label_or_alias' });
});

test('bounded name-derived domains are industry-aware and require page identity evidence', async () => {
  assert.deepEqual(nameDerivedDomains('iM3 Inc', 'Veterinary'), ['im3.com', 'im3vet.com']);
  assert.deepEqual(nameDerivedDomains('Patterson Dental Supply', 'Veterinary'), ['pattersondental.com']);
  const seen = [];
  const result = await websiteFromNameDerivedDomain('iM3 Inc', {
    industry: 'Veterinary',
    httpFetch: async (url) => {
      seen.push(url);
      if (url === 'https://im3.com') throw new Error('not found');
      return { ok: true, url: 'https://im3vet.com/', text: async () => '<title>iM3 Veterinary Dental</title>' };
    },
  });
  assert.deepEqual(seen, ['https://im3.com', 'https://im3vet.com']);
  assert.deepEqual(result, { website: 'https://im3vet.com/', domain_guess: 'im3vet.com', match: 'name_derived_domain_with_page_identity' });
});

test('Adzuna market results are sales-filtered, employer-deduped, and enriched without resolving known employers again', async () => {
  const jobs = [
    { id: 1, title: 'Territory Sales Manager', company: { display_name: 'Known Diagnostics' }, redirect_url: 'https://adzuna.example/1', created: '2026-10-05', location: { display_name: 'Tampa, FL' } },
    { id: 2, title: 'Territory Sales Manager', company: { display_name: 'Known Diagnostics' }, redirect_url: 'https://adzuna.example/2' },
    { id: 3, title: 'Veterinarian', company: { display_name: 'Generic Vet Clinic' }, redirect_url: 'https://adzuna.example/3' },
    { id: 4, title: 'Pharmaceutical Sales Representative', company: { display_name: 'New Pharma' }, redirect_url: 'https://adzuna.example/4' },
    { id: 5, title: 'Medical Device Sales', company: { display_name: 'Acme Recruiting' }, redirect_url: 'https://adzuna.example/5' },
  ];
  let websiteCalls = 0;
  const result = await discoverMarketSignals({
    now: new Date('2026-10-06T12:00:00Z'), queryLimit: 1,
    knownEmployers: [{ id: 'known-1', company_name: 'Known Diagnostics', company_website: 'https://known.example' }],
    fetchJobs: async () => jobs,
    resolveWebsite: async (name) => { websiteCalls++; return name === 'New Pharma' ? { website: 'https://newpharma.example', entity_id: 'Q2' } : null; },
  });
  assert.equal(result.signals.length, 2);
  assert.equal(result.stats.duplicate_jobs, 1);
  assert.equal(result.stats.rejected_agency_or_generic, 1);
  assert.equal(result.stats.existing_employer_signals, 1);
  assert.equal(websiteCalls, 1);
  assert.equal(result.signals.find((signal) => signal.company_name === 'New Pharma').company_website, 'https://newpharma.example');
});

test('shadow mode is read-only and reports known versus unknown employers', async () => {
  let pipelineCalls = 0;
  const store = { listEmployers: async () => [{ id: 'e1', company_name: 'Known Co' }] };
  const summary = await run(['--shadow', '--limit', '5'], {
    store,
    pipeline: { processSignal: async () => { pipelineCalls++; } },
    discoverSignals: async () => ({ stats: { fetched_jobs: 3 }, signals: [
      { company_name: 'Known Co', job_title: 'Medical Sales Representative', company_website: null, industry: 'Medical Device' },
      { company_name: 'New Co', job_title: 'Diagnostics Sales Manager', company_website: 'https://new.example', industry: 'Diagnostics / Laboratory' },
    ] }),
  });
  assert.equal(summary.existing_employers, 1);
  assert.equal(summary.unknown_employers, 1);
  assert.equal(summary.unknown_with_official_website, 1);
  assert.equal(pipelineCalls, 0);
});

test('apply mode sends every emitted signal through the Phase 2 gate and summarizes outcomes', async () => {
  const seen = [];
  const store = { listEmployers: async () => [], listDueCandidates: async () => [] };
  const summary = await run(['--apply', '--limit', '5'], {
    store,
    pipeline: { processSignal: async (signal) => { seen.push(signal.company_name); return { status: signal.company_name === 'Valid Co' ? 'enrolled' : 'unresolved', candidate: { id: signal.company_name }, employer: signal.company_name === 'Valid Co' ? { id: 'employer-1' } : null }; } },
    discoverSignals: async () => ({ stats: { fetched_jobs: 2 }, signals: [
      { company_name: 'Valid Co' }, { company_name: 'Unsupported Co' },
    ] }),
  });
  assert.deepEqual(seen, ['Valid Co', 'Unsupported Co']);
  assert.deepEqual(summary.statuses, { enrolled: 1, unresolved: 1 });
});

test('CLI requires an explicit safe mode and enforces bounded work', () => {
  assert.throws(() => parseArgs([]), /--shadow or --apply/);
  assert.throws(() => parseArgs(['--apply', '--limit', '100']), /1 to 50/);
  assert.equal(parseArgs(['--shadow', '--query-limit', '3']).queryLimit, 3);
});
