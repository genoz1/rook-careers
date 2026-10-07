const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EmployerDiscoveryPipeline, identityKey } = require('./discovery/pipeline');
const { resolveOfficialSource, detectFromUrl, detectSourceConfigurations, searchOfficialCareerCandidates, createPublicSearchSession, directOfficialDomainCandidates } = require('./discovery/sourceResolver');
const { plausibleJob, sourceIsAnchored, validateSource } = require('./discovery/sourceValidator');
const { fetchCustomHtmlJobs } = require('./adapters/customHtml');
const { parseInput, parseArgs, run } = require('./runEmployerDiscovery');
const { assessSignalFreshness, mergeSignalPayload } = require('./discovery/evidenceFreshness');

class MemoryStore {
  constructor(employers = []) {
    this.candidates = [];
    this.employers = employers.map((row) => ({ ...row }));
    this.enrollCalls = 0;
  }
  async getCandidate(key) { return this.candidates.find((row) => row.identity_key === key) || null; }
  async receiveCandidate(row) {
    const existing = await this.getCandidate(row.identity_key) || (row.company_domain && this.candidates.find((candidate) => candidate.company_domain === row.company_domain));
    if (existing) {
      const freshness = assessSignalFreshness(existing.signal_payload, row.signal_payload);
      Object.assign(existing, {
        last_signal_at: row.last_signal_at,
        signal_payload: mergeSignalPayload(existing.signal_payload, row.signal_payload, row.last_signal_at),
        company_website: row.company_website || existing.company_website,
        careers_url: row.careers_url || existing.careers_url,
        job_url: row.job_url || existing.job_url,
      });
      return { candidate: { ...existing }, duplicate: true, freshEvidence: freshness.fresh, evidenceFingerprint: freshness.fingerprint };
    }
    const candidate = { id: `candidate-${this.candidates.length + 1}`, attempt_count: 0, ...row,
      signal_payload: mergeSignalPayload(null, row.signal_payload, row.last_signal_at) };
    this.candidates.push(candidate);
    return { candidate: { ...candidate }, duplicate: false, freshEvidence: false, evidenceFingerprint: null };
  }
  async updateCandidate(id, patch) {
    const candidate = this.candidates.find((row) => row.id === id);
    Object.assign(candidate, patch);
    return { ...candidate };
  }
  async listEmployers() { return this.employers.map((row) => ({ ...row })); }
  async findCandidateBySource(type, identifier) {
    return this.candidates.find((row) => row.detected_ats_type === type && row.detected_ats_identifier === identifier && ['existing', 'enrolled'].includes(row.status)) || null;
  }
  async listCandidatesByIds(ids) { return ids.map((id) => this.candidates.find((candidate) => candidate.id === id)).filter(Boolean); }
  async enrollEmployer(candidate, configuration) {
    this.enrollCalls++;
    const employer = {
      id: `employer-${this.employers.length + 1}`,
      company_name: candidate.company_name,
      company_slug: candidate.normalized_company_name.replace(/\s+/g, '-'),
      company_website: candidate.company_website,
      careers_url: configuration.source_url,
      ats_type: configuration.ats_type,
      ats_identifier: configuration.ats_identifier,
      active: true,
      discovery_candidate_id: candidate.id,
    };
    this.employers.push(employer);
    return { ...employer };
  }
}

const signal = {
  company_name: 'Acme Medical, Inc.',
  company_website: 'https://acmemedical.example',
  careers_url: 'https://boards.greenhouse.io/acmemedical',
  job_url: 'https://boards.greenhouse.io/acmemedical/jobs/123',
  job_title: 'Territory Sales Manager',
  industry: 'medical device',
  signal_source: 'fixture-provider',
};

function resolved(configuration = { ats_type: 'greenhouse', ats_identifier: 'acmemedical', source_url: signal.careers_url }) {
  return {
    official_url: signal.company_website,
    official_domain: 'acmemedical.example',
    careers_pages: [signal.careers_url],
    configurations: [configuration],
    evidence: { official_url: signal.company_website, official_link_targets: [signal.careers_url] },
  };
}

const passValidation = async () => ({ ok: true, status: 'PASS_VALIDATED_SOURCE', plausible_job_count: 1, sample_jobs: [{ title: 'Territory Sales Manager' }] });

test('existing employer is deduplicated by normalized company identity before expensive resolution', async () => {
  const store = new MemoryStore([{ id: 'existing-1', company_name: 'Acme Medical LLC', company_slug: 'acme-medical', company_website: 'https://acmemedical.example', ats_type: 'greenhouse', ats_identifier: 'acmemedical', active: true }]);
  let resolveCalls = 0;
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: async () => { resolveCalls++; return resolved(); }, validate: passValidation });
  const result = await pipeline.processSignal(signal);
  assert.equal(result.status, 'existing');
  assert.equal(resolveCalls, 0);
  assert.equal(store.enrollCalls, 0);
  assert.equal(result.candidate.evidence.external_job_signal.reason, 'EXTERNAL_JOB_SIGNAL_FOR_MONITORED_EMPLOYER');
  assert.equal(result.candidate.evidence.external_job_signal.investigation_required, true);
});

test('official-page ATS detection plus successful machine validation auto-enrolls exactly once', async () => {
  const pages = new Map([
    ['https://acmemedical.example/', { url: 'https://acmemedical.example/', html: '<a href="https://boards.greenhouse.io/acmemedical">Careers</a>' }],
    ['https://boards.greenhouse.io/acmemedical', { url: 'https://boards.greenhouse.io/acmemedical', html: '<h1>Acme jobs</h1>' }],
  ]);
  const store = new MemoryStore();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /boards-api\.greenhouse\.io\/v1\/boards\/acmemedical\/jobs/);
    return { ok: true, json: async () => ({ jobs: [{ id: 123, title: 'Territory Sales Manager', absolute_url: 'https://boards.greenhouse.io/acmemedical/jobs/123', location: { name: 'Tampa, FL' }, content: '<p>Sell medical devices to hospitals across the territory.</p>', updated_at: '2026-10-01T00:00:00Z' }] }) };
  };
  try {
    const pipeline = new EmployerDiscoveryPipeline({
      store,
      resolveSource: (input) => resolveOfficialSource(input, { readPage: async (url) => {
        const page = pages.get(url) || pages.get(url.replace(/\/$/, '') + '/');
        if (!page) throw new Error(`unexpected fixture URL ${url}`);
        return page;
      }, searchCareers: async () => [] }),
      validate: validateSource,
    });
    const first = await pipeline.processSignal(signal);
    const second = await pipeline.processSignal({ ...signal, source_signal_id: 'duplicate-2' });
    assert.equal(first.status, 'enrolled');
    assert.equal(first.validation.status, 'PASS_VALIDATED_SOURCE');
    assert.equal(first.employer.active, true);
    assert.equal(first.employer.ats_type, 'greenhouse');
    assert.equal(first.employer.ats_identifier, 'acmemedical');
    assert.equal(second.status, 'enrolled');
    assert.equal(store.enrollCalls, 1);
    assert.equal(store.employers.length, 1);
  } finally {
    global.fetch = realFetch;
  }
});

test('wrong or bad source never creates an active employer', async () => {
  const store = new MemoryStore();
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: async () => resolved(), validate: async () => ({ ok: false, status: 'NO_PLAUSIBLE_JOBS' }) });
  const result = await pipeline.processSignal(signal);
  assert.equal(result.status, 'retryable');
  assert.equal(store.enrollCalls, 0);
  assert.equal(store.employers.length, 0);
  assert.equal(store.candidates[0].validation_status, 'VALIDATION_FAILED');
});

test('unsupported official careers source is retained as unresolved with retry evidence', async () => {
  const pages = new Map([
    ['https://acmemedical.example/', { url: 'https://acmemedical.example/', html: '<a href="/careers">Careers</a>' }],
    ['https://acmemedical.example/careers', { url: 'https://acmemedical.example/careers', html: '<main><h1>Careers</h1><p>Openings load in an unsupported widget.</p></main>' }],
  ]);
  const store = new MemoryStore();
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: (input) => resolveOfficialSource(input, { readPage: async (url) => pages.get(url), searchCareers: async () => [] }), validate: passValidation });
  const result = await pipeline.processSignal({ ...signal, careers_url: 'https://acmemedical.example/careers', job_url: null });
  assert.equal(result.status, 'unresolved');
  assert.equal(store.enrollCalls, 0);
  assert.equal(store.candidates[0].validation_status, 'UNSUPPORTED_SOURCE');
  assert.ok(store.candidates[0].next_attempt_at);
  assert.ok(store.candidates[0].evidence.attempted_pages.includes('https://acmemedical.example/careers'));
});

test('a supplied website that does not corroborate the company identity is not treated as official', async () => {
  const pages = new Map([
    ['https://unrelated.example/', { url: 'https://unrelated.example/', html: '<title>Unrelated Software</title><a href="https://boards.greenhouse.io/unrelated">Careers</a>' }],
  ]);
  const store = new MemoryStore();
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: (input) => resolveOfficialSource(input, {
    readPage: async (url) => pages.get(url) || pages.get(`${url}/`),
    searchCareers: async () => [],
  }), validate: passValidation });
  const result = await pipeline.processSignal({ ...signal, company_website: 'https://unrelated.example', careers_url: null, job_url: null });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.candidate.validation_status, 'COMPANY_IDENTITY_MISMATCH');
  assert.equal(store.enrollCalls, 0);
});

test('structured JobPosting fallback is attempted as custom_html and remains retryable when validation fails', async () => {
  const configs = detectSourceConfigurations([{ url: 'https://acmemedical.example/careers', html: '<script type="application/ld+json">{"@type":"JobPosting","title":"Sales Representative"}</script>' }]);
  assert.equal(configs[0].ats_type, 'custom_html');
  const store = new MemoryStore();
  const customResolved = { ...resolved(configs[0]), official_domain: 'acmemedical.example', careers_pages: [configs[0].source_url] };
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: async () => customResolved, validate: async (configuration) => ({ ok: false, status: configuration.ats_type === 'custom_html' ? 'NO_PLAUSIBLE_JOBS' : 'unexpected' }) });
  const result = await pipeline.processSignal({ ...signal, careers_url: 'https://acmemedical.example/careers', job_url: null });
  assert.equal(result.status, 'retryable');
  assert.equal(result.validation_attempts[0].configuration.ats_type, 'custom_html');
  assert.equal(store.enrollCalls, 0);
});

test('retryable candidate is deferred until due, then can validate and enroll', async () => {
  const store = new MemoryStore();
  let clock = new Date('2026-10-06T12:00:00Z');
  let resolutionCalls = 0;
  const pipeline = new EmployerDiscoveryPipeline({
    store,
    now: () => new Date(clock),
    resolveSource: async () => { resolutionCalls++; if (resolutionCalls === 1) throw new Error('temporary network failure'); return resolved(); },
    validate: passValidation,
  });
  const first = await pipeline.processSignal(signal);
  const deferred = await pipeline.processSignal(signal);
  clock = new Date('2026-10-08T12:00:00Z');
  const retried = await pipeline.processSignal(signal);
  assert.equal(first.status, 'retryable');
  assert.equal(deferred.status, 'deferred');
  assert.equal(retried.status, 'enrolled');
  assert.equal(store.candidates[0].attempt_count, 2);
  assert.equal(store.enrollCalls, 1);
});

test('fresh current-job evidence wakes an unresolved candidate before its retry date', async () => {
  const store = new MemoryStore();
  const oldSignal = { company_name: 'Wakeable Medical', signal_source: 'linkedin-public-jobs', source_signal_id: 'job-1', job_url: 'https://www.linkedin.com/jobs/view/job-1' };
  store.candidates.push({
    id: 'wakeable-1', identity_key: identityKey(oldSignal), company_name: oldSignal.company_name,
    normalized_company_name: 'wakeable medical', signal_payload: mergeSignalPayload(null, oldSignal, '2026-10-01T00:00:00.000Z'),
    status: 'unresolved', attempt_count: 1, next_attempt_at: '2026-10-14T00:00:00.000Z',
  });
  let resolveCalls = 0;
  const pipeline = new EmployerDiscoveryPipeline({
    store, now: () => new Date('2026-10-07T12:00:00.000Z'),
    resolveSource: async () => { resolveCalls++; return resolved(); }, validate: passValidation,
  });
  const result = await pipeline.processSignal({ ...oldSignal, source_signal_id: 'job-2', job_url: 'https://www.linkedin.com/jobs/view/job-2' });
  assert.equal(result.status, 'enrolled');
  assert.equal(result.awakened_by_fresh_evidence, true);
  assert.equal(resolveCalls, 1);
  assert.equal(store.candidates[0].attempt_count, 2);
  assert.ok(store.candidates[0].evidence.fresh_signal_wake);
});

test('unchanged current-job evidence continues to respect retry backoff', async () => {
  const store = new MemoryStore();
  const oldSignal = { company_name: 'Backoff Medical', signal_source: 'linkedin-public-jobs', source_signal_id: 'same-job', job_url: 'https://www.linkedin.com/jobs/view/same-job' };
  store.candidates.push({
    id: 'backoff-1', identity_key: identityKey(oldSignal), company_name: oldSignal.company_name,
    normalized_company_name: 'backoff medical', signal_payload: mergeSignalPayload(null, oldSignal, '2026-10-01T00:00:00.000Z'),
    status: 'unresolved', attempt_count: 1, next_attempt_at: '2026-10-14T00:00:00.000Z',
  });
  let resolveCalls = 0;
  const pipeline = new EmployerDiscoveryPipeline({
    store, now: () => new Date('2026-10-07T12:00:00.000Z'),
    resolveSource: async () => { resolveCalls++; return resolved(); }, validate: passValidation,
  });
  const result = await pipeline.processSignal(oldSignal);
  assert.equal(result.status, 'deferred');
  assert.equal(result.awakened_by_fresh_evidence, false);
  assert.equal(resolveCalls, 0);
  assert.equal(store.candidates[0].attempt_count, 1);
});

test('materially improved official-domain evidence wakes the same current job signal', async () => {
  const store = new MemoryStore();
  const oldSignal = { company_name: 'Improved Evidence Medical', signal_source: 'linkedin-public-jobs', source_signal_id: 'same-job', job_url: 'https://www.linkedin.com/jobs/view/same-job' };
  store.candidates.push({
    id: 'improved-1', identity_key: identityKey(oldSignal), company_name: oldSignal.company_name,
    normalized_company_name: 'improved evidence medical', signal_payload: mergeSignalPayload(null, oldSignal, '2026-10-01T00:00:00.000Z'),
    status: 'unresolved', attempt_count: 1, next_attempt_at: '2026-10-14T00:00:00.000Z',
  });
  let receivedWebsite = null;
  const pipeline = new EmployerDiscoveryPipeline({
    store, now: () => new Date('2026-10-07T12:00:00.000Z'),
    resolveSource: async (input) => { receivedWebsite = input.company_website; return resolved(); }, validate: passValidation,
  });
  const result = await pipeline.processSignal({ ...oldSignal, company_website: 'https://improved-evidence.example/' });
  assert.equal(result.status, 'enrolled');
  assert.equal(result.awakened_by_fresh_evidence, true);
  assert.equal(receivedWebsite, 'https://improved-evidence.example/');
});

test('unresolved fresh job signal retains a durable coverage discrepancy for repair', async () => {
  const store = new MemoryStore();
  const previous = { company_name: 'Repair Medical', signal_source: 'fixture-seed' };
  store.candidates.push({
    id: 'repair-1', identity_key: identityKey(previous), company_name: previous.company_name,
    normalized_company_name: 'repair medical', signal_payload: previous,
    status: 'unresolved', attempt_count: 1, next_attempt_at: '2026-10-14T00:00:00.000Z',
  });
  const failure = Object.assign(new Error('No safe official careers source'), { code: 'UNSUPPORTED_SOURCE', evidence: { attempted_pages: ['https://repair.example/careers'] } });
  const pipeline = new EmployerDiscoveryPipeline({
    store, now: () => new Date('2026-10-07T12:00:00.000Z'), resolveSource: async () => { throw failure; }, validate: passValidation,
  });
  const result = await pipeline.processSignal({ ...previous, signal_source: 'linkedin-public-jobs', source_signal_id: 'repair-job-2', job_url: 'https://www.linkedin.com/jobs/view/repair-job-2', job_title: 'Medical Sales Manager' });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.awakened_by_fresh_evidence, true);
  assert.equal(result.repair_condition_created, true);
  assert.equal(result.candidate.evidence.coverage_discrepancy.status, 'open');
  assert.equal(result.candidate.evidence.coverage_discrepancy.reason, 'UNSUPPORTED_SOURCE');
  assert.deepEqual(result.candidate.evidence.attempted_pages, ['https://repair.example/careers']);
});

test('different company-name signals sharing an official domain reuse one durable candidate', async () => {
  const store = new MemoryStore();
  let resolveCalls = 0;
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: async () => { resolveCalls++; throw new Error('temporary network failure'); }, validate: passValidation });
  const first = await pipeline.processSignal(signal);
  const alias = await pipeline.processSignal({ ...signal, company_name: 'Acme Medical Holdings' });
  assert.equal(first.status, 'retryable');
  assert.equal(alias.status, 'deferred');
  assert.equal(store.candidates.length, 1);
  assert.equal(resolveCalls, 1);
});

test('confidence or AI/provider assertions cannot bypass the validation gate', async () => {
  const store = new MemoryStore();
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: async () => resolved(), validate: async () => ({ ok: false, status: 'SOURCE_VALIDATION_FAILED' }) });
  const result = await pipeline.processSignal({ ...signal, confidence: 1, ai_verified: true, provider_says_official: true });
  assert.equal(result.status, 'retryable');
  assert.equal(store.enrollCalls, 0);
});

test('plausible-job gate requires active, verified, relevant, source-anchored listing', () => {
  const config = { ats_type: 'greenhouse', ats_identifier: 'acmemedical', source_url: 'https://boards.greenhouse.io/acmemedical' };
  const base = { source_job_id: '1', title_original: 'Territory Sales Manager', description_text: 'Sell medical devices.', source_url: 'https://boards.greenhouse.io/acmemedical/jobs/1', status: 'active', source_verified: true };
  assert.equal(plausibleJob(base, config), true);
  assert.equal(plausibleJob({ ...base, source_verified: false }, config), false);
  assert.equal(plausibleJob({ ...base, status: 'closed' }, config), false);
  assert.equal(plausibleJob({ ...base, title_original: 'Veterinarian' }, config), false);
  assert.equal(plausibleJob({ ...base, source_url: 'https://boards.greenhouse.io/wrongcompany/jobs/1' }, config), false);
});

test('URL extraction handles identifiers that cannot be guessed from company name', () => {
  assert.deepEqual(detectFromUrl('https://recruiting2.ultipro.com/ARU1000ARUP/JobBoard/62cc791d-612e-42e6-909f-0de27efe2038'), {
    ats_type: 'ukg', ats_identifier: 'recruiting2.ultipro.com|ARU1000ARUP|62cc791d-612e-42e6-909f-0de27efe2038', source_url: 'https://recruiting2.ultipro.com/ARU1000ARUP/JobBoard/62cc791d-612e-42e6-909f-0de27efe2038',
  });
  assert.equal(detectFromUrl('https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=3b6256c1-2a46-4436-9cdb-bc5511fc6ab2').ats_identifier, '3b6256c1-2a46-4436-9cdb-bc5511fc6ab2');
  assert.equal(detectFromUrl('https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs').ats_identifier, 'tenant.fa.us2.oraclecloud.com|CX_1');
  assert.equal(detectFromUrl('https://recruiting.paylocity.com/recruiting/jobs/All/5185d630-7b08-4a17-b664-4c81d3030393/Openings').ats_identifier, '5185d630-7b08-4a17-b664-4c81d3030393');
});

test('source-agnostic input accepts JSON arrays and JSONL without provider coupling', () => {
  assert.equal(parseInput(JSON.stringify([signal])).length, 1);
  assert.equal(parseInput(`${JSON.stringify(signal)}\n${JSON.stringify({ ...signal, company_name: 'Other' })}`).length, 2);
});

test('public careers search resolves companies without a supplied or guessed domain', async () => {
  const pages = new Map([
    ['https://workwave.example/careers', { url: 'https://workwave.example/careers', html: '<title>WorkWave Careers</title><a href="https://boards.greenhouse.io/workwave">See open positions</a>' }],
    ['https://boards.greenhouse.io/workwave', { url: 'https://boards.greenhouse.io/workwave', html: '<h1>WorkWave jobs</h1>' }],
  ]);
  const result = await resolveOfficialSource({ company_name: 'WorkWave' }, {
    searchCareers: async () => [{ url: 'https://workwave.example/careers', title: 'Careers - WorkWave', snippet: 'Join WorkWave', provider: 'fixture-search' }],
    readPage: async (url) => { const page = pages.get(url); if (!page) throw new Error(`unexpected ${url}`); return page; },
  });
  assert.equal(result.official_domain, 'workwave.example');
  assert.equal(result.configurations[0].ats_type, 'greenhouse');
  assert.equal(result.evidence.selected_candidate.kind, 'public_search_result');
});

test('public search ranking uses the registrable company domain instead of a generic subdomain', async () => {
  const html = '<div class="result"><a class="result__a" href="https://banfield.mycareerhs.com/careers">Banfield Pet Hospital careers</a><span class="result__snippet">Banfield employee education</span></div>' +
    '<div class="result"><a class="result__a" href="https://jobs.banfield.com/">Banfield Pet Hospital jobs</a><span class="result__snippet">Official jobs</span></div>';
  const results = await searchOfficialCareerCandidates('Banfield Pet Hospital', {
    httpFetch: async () => ({ ok: true, text: async () => html }),
  });
  assert.equal(results[0].url, 'https://jobs.banfield.com/');
});

test('empty DuckDuckGo batch responses fall back to bounded Bing RSS results', async () => {
  const calls = [];
  const results = await searchOfficialCareerCandidates('AutoRemind', {
    httpFetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('bing.com')) return {
        ok: true,
        text: async () => '<rss><channel><item><title>Careers | AutoRemind</title><link>https://www.autoremind.com/jobs</link><description>Official AutoRemind jobs</description></item></channel></rss>',
      };
      return { ok: true, text: async () => '<html><body>No results in this transient response.</body></html>' };
    },
  });
  assert.equal(results[0].url, 'https://www.autoremind.com/jobs');
  assert.equal(results[0].provider, 'bing-rss');
  assert.equal(calls.filter((url) => url.includes('duckduckgo.com')).length, 1);
  assert.equal(calls.filter((url) => url.includes('bing.com')).length, 1);
});

test('ten-candidate force batch survives provider degradation without poisoning later candidates', async () => {
  const names = [
    'AutoRemind', 'Banfield Pet Hospital', 'BluePearl Specialty + Emergency Pet Hospital', 'Arthrex Vet Systems',
    'Merck Animal Health', 'PetVet Care Centers', 'Instinct Pet Food', 'Farmina Pet Food', 'Ardent Animal Health', 'Animal Biome',
  ];
  const store = new MemoryStore();
  const ids = names.map((name, index) => {
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const vmxSignal = { company_name: name, industry: 'animal health', signal_source: 'vmx-2027-exhibitor-list' };
    store.candidates.push({
      id, identity_key: identityKey(vmxSignal), company_name: name,
      normalized_company_name: name.toLowerCase(), signal_payload: vmxSignal, status: 'unresolved', attempt_count: 1,
    });
    return id;
  });
  let duckCalls = 0;
  let bingCalls = 0;
  const httpFetch = async (url) => {
    const target = String(url);
    const queryName = new URL(target).searchParams.get('q').replace(/ animal health careers jobs$/, '');
    const index = names.indexOf(queryName);
    if (target.includes('duckduckgo.com')) {
      duckCalls++;
      if (index < 3) return { ok: true, text: async () => `<div class="result"><a class="result__a" href="https://search-${index}.example/careers">${queryName} careers</a><span class="result__snippet">Official ${queryName} jobs</span></div>` };
      return { ok: true, text: async () => '<html><body>Transient empty provider response</body></html>' };
    }
    bingCalls++;
    return { ok: true, text: async () => '<rss><channel><item><title>Unrelated directory</title><link>https://unrelated.example/</link><description>Nothing about this company</description></item></channel></rss>' };
  };
  const pages = new Map();
  names.forEach((name, index) => {
    pages.set(`https://search-${index}.example/careers`, { url: `https://search-${index}.example/careers`, html: `<title>${name} Careers</title><script type="application/ld+json">{"@type":"JobPosting","title":"Veterinarian"}</script>` });
    const home = directOfficialDomainCandidates(name)[0].url;
    const careers = new URL('/careers', home).href;
    pages.set(home, { url: home, html: `<title>${name}</title><a href="/careers">Careers</a>` });
    pages.set(careers, { url: careers, html: `<title>${name} Careers</title><script type="application/ld+json">{"@type":"JobPosting","title":"Veterinarian"}</script>` });
  });
  const results = await run(['--force-candidate-id', ids.join(','), '--limit', '10'], {
    store, httpFetch,
    readPage: async (url) => { const page = pages.get(url); if (!page) throw new Error(`fixture unavailable: ${url}`); return page; },
    validate: async () => ({ ok: true, status: 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS', plausible_job_count: 0, inventory_job_count: 1 }),
  });
  assert.equal(results.length, 10);
  assert.ok(results.every((item) => item.status === 'enrolled'));
  assert.equal(results[9].validation_status, 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS');
  assert.equal(results[9].source_type, 'custom_html');
  assert.ok(results[9].search_provider_trace.every((entry) => entry.status === 'circuit_open'));
  assert.equal(duckCalls, 5);
  assert.equal(bingCalls, 2);
});

test('empty responses from every public provider remain retryable instead of an identity rejection', async () => {
  await assert.rejects(
    searchOfficialCareerCandidates('Temporary Search Outage', {
      httpFetch: async () => ({ ok: true, text: async () => '<html><body>No parseable results.</body></html>' }),
    }),
    /no parseable.*results/i,
  );
});

test('total search outage with exhausted safe domain fallbacks is retryable, not terminally unresolved', async () => {
  const store = new MemoryStore();
  const session = createPublicSearchSession({
    httpFetch: async () => ({ ok: true, text: async () => '<html><body>No results</body></html>' }),
  });
  const pipeline = new EmployerDiscoveryPipeline({
    store,
    resolveSource: (input) => resolveOfficialSource(input, {
      searchCareers: (name, options) => searchOfficialCareerCandidates(name, { ...options, searchSession: session }),
      readPage: async (url) => { throw new Error(`unavailable fixture domain: ${url}`); },
    }),
    validate: passValidation,
  });
  const result = await pipeline.processSignal({ company_name: 'Temporary Search Outage', industry: 'animal health', signal_source: 'fixture' });
  assert.equal(result.status, 'retryable');
  assert.equal(result.candidate.validation_status, 'SEARCH_PROVIDERS_UNAVAILABLE');
  assert.ok(result.candidate.evidence.search_provider_trace.length >= 2);
});

test('verified subsidiary site may lead to a parent shared careers system with a provenance chain', async () => {
  const pages = new Map([
    ['https://aesculap.example/', { url: 'https://aesculap.example/', html: '<title>Aesculap US</title><a href="https://careers.bbraun.example/jobs">Careers at our parent B. Braun</a>' }],
    ['https://careers.bbraun.example/jobs', { url: 'https://careers.bbraun.example/jobs', html: '<title>B. Braun careers</title><a href="https://bbraun.wd5.myworkdayjobs.com/en-US/External/job/1">Open positions</a>' }],
    ['https://bbraun.wd5.myworkdayjobs.com/en-US/External/job/1', { url: 'https://bbraun.wd5.myworkdayjobs.com/en-US/External/job/1', html: '<h1>Aesculap opportunity</h1>' }],
  ]);
  const result = await resolveOfficialSource({ company_name: 'Aesculap (US)', company_website: 'https://aesculap.example/' }, {
    searchCareers: async () => [],
    readPage: async (url) => { const page = pages.get(url); if (!page) throw new Error(`unexpected ${url}`); return page; },
  });
  assert.equal(result.configurations[0].ats_type, 'workday');
  assert.equal(result.configurations[0].ats_identifier, 'bbraun|wd5|External');
  assert.ok(result.evidence.provenance_chains.some((chain) => chain.linked_from === 'https://aesculap.example/'));
});

test('embedded Paycor destination is detected from a verified official careers page', async () => {
  const result = await resolveOfficialSource({ company_name: 'Zomedica', company_website: 'https://zomedica.example/careers/' }, {
    searchCareers: async () => [],
    readPage: async () => ({ url: 'https://zomedica.example/careers/', html: '<title>Careers - Zomedica</title><h1>Open positions</h1><script src="https://recruitingbypaycor.com/career/iframe.action?clientId=8a7883d08145828d0181914c5b7a2fa1"></script>' }),
  });
  assert.deepEqual(result.configurations.map((item) => [item.ats_type, item.ats_identifier]), [['paycor', '8a7883d08145828d0181914c5b7a2fa1']]);
  assert.equal(result.configurations[0].evidence.kind, 'official_page_link');
});

test('unknown source falls through to verified official sitemap and structured job extraction', async () => {
  const pages = new Map([
    ['https://spire.example/', { url: 'https://spire.example/', html: '<title>Spire</title><a href="/careers">Careers</a>' }],
    ['https://spire.example/careers', { url: 'https://spire.example/careers', html: '<h1>Spire careers</h1><p>Browse opportunities.</p>' }],
    ['https://spire.example/sitemap.xml', { url: 'https://spire.example/sitemap.xml', html: '<urlset><url><loc>https://spire.example/jobs/sales-manager</loc></url></urlset>' }],
    ['https://spire.example/jobs/sales-manager', { url: 'https://spire.example/jobs/sales-manager', html: '<script type="application/ld+json">{"@type":"JobPosting","title":"Territory Sales Manager","description":"Sell healthcare products throughout the assigned territory and support customers.","url":"https://spire.example/jobs/sales-manager"}</script>' }],
  ]);
  const result = await resolveOfficialSource({ company_name: 'Spire', company_website: 'https://spire.example/' }, {
    searchCareers: async () => [],
    readPage: async (url) => { const page = pages.get(url); if (!page) throw new Error(`unexpected ${url}`); return page; },
  });
  assert.equal(result.configurations[0].ats_type, 'custom_html');
  assert.ok(result.evidence.provenance_chains.some((chain) => chain.kind === 'verified_official_sitemap'));
});

test('career hostnames are followed even when the link path is a locale root', async () => {
  const pages = new Map([
    ['https://jnj.example/innovativemedicine', { url: 'https://jnj.example/innovativemedicine', html: '<title>Johnson & Johnson Innovative Medicine</title><a href="https://careers.jnj.example/en/">Explore opportunities</a>' }],
    ['https://careers.jnj.example/en/', { url: 'https://careers.jnj.example/en/', html: '<title>J&J careers</title><a href="https://jj.wd5.myworkdayjobs.com/en-US/JJ/jobs">Search roles</a>' }],
    ['https://jj.wd5.myworkdayjobs.com/en-US/JJ/jobs', { url: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/jobs', html: '<h1>J&J jobs</h1>' }],
  ]);
  const result = await resolveOfficialSource({ company_name: 'Johnson & Johnson Innovative Medicine', company_website: 'https://jnj.example/innovativemedicine' }, {
    searchCareers: async () => [],
    readPage: async (url) => { const page = pages.get(url); if (!page) throw new Error(`unexpected ${url}`); return page; },
  });
  assert.ok(result.careers_pages.includes('https://careers.jnj.example/en/'));
  assert.ok(result.configurations.some((configuration) => configuration.ats_type === 'workday' && configuration.ats_identifier === 'jj|wd5|JJ'));
});

test('verified first-party job detail listings activate the bounded custom HTML fallback', () => {
  const configs = detectSourceConfigurations([{
    url: 'https://spire.example/careers/job-openings/',
    html: '<main><h1>Spire job openings</h1><a href="/careers/job-openings/job/?gh_jid=8238125">Sales Account Manager — Remote — Apply</a></main>',
  }]);
  assert.equal(configs[0].ats_type, 'custom_html');
  assert.equal(configs[0].evidence.kind, 'bounded_official_job_links');
});

test('Workday source anchoring uses the detected tenant identity even when the official-link URL redirected', () => {
  const configuration = { ats_type: 'workday', ats_identifier: 'mvh|wd115|antechcareers', source_url: 'https://careers.antechdiagnostics.example/open-roles' };
  const job = { source_url: 'https://mvh.wd115.myworkdayjobs.com/antechcareers/job/Remote/Diagnostic-Sales-Manager_R-1' };
  assert.equal(sourceIsAnchored(job, configuration), true);
});

test('targeted force retry accepts explicit candidate UUIDs and bypasses scheduling only for those targets', async () => {
  const id = '7db79ad7-805f-4ceb-967f-03a377a2101f';
  assert.deepEqual(parseArgs(['--force-candidate-id', id]).forceCandidateIds, [id]);
  assert.throws(() => parseArgs(['--force-candidate-id', 'not-a-uuid']), /explicit UUID/);
  const candidate = { id, company_name: 'Heska', signal_payload: { company_name: 'Heska', signal_source: 'fixture' } };
  const seen = [];
  const results = await run(['--force-candidate-id', id], {
    store: { listCandidatesByIds: async () => [candidate] },
    pipeline: { processSignal: async (input, options) => { seen.push({ input, options }); return { status: 'retryable', candidate }; } },
  });
  assert.equal(results[0].candidate_id, id);
  assert.deepEqual(seen[0].options, { force: true, candidateId: id });
});

test('signal CLI enrollment ingests newly enrolled sources and reports inserted relevant jobs', async () => {
  const id = '7db79ad7-805f-4ceb-967f-03a377a2101f';
  const candidate = { id, company_name: 'Heska', signal_payload: { company_name: 'Heska', signal_source: 'fixture' } };
  const employer = { id: 'employer-1', company_name: 'Heska', careers_url: 'https://jobs.example/', ats_type: 'custom_html' };
  let ingested = 0;
  let countReads = 0;
  const results = await run(['--force-candidate-id', id, '--ingest-enrolled'], {
    store: { listCandidatesByIds: async () => [candidate] },
    pipeline: { processSignal: async () => ({ status: 'enrolled', candidate: { ...candidate, validation_status: 'PASS_VALIDATED_SOURCE' }, employer }) },
    ingestEmployer: async (received) => { ingested++; assert.equal(received.id, employer.id); return { status: 'completed' }; },
    countActiveJobs: async () => countReads++ === 0 ? 0 : 3,
  });
  assert.equal(ingested, 1);
  assert.equal(results[0].ingestion_status, 'completed');
  assert.equal(results[0].active_relevant_jobs, 3);
  assert.equal(results[0].relevant_jobs_inserted, 3);
});

test('real force-reprocess CLI path recovers a minimal VMX signal through the fallback search provider', async () => {
  const id = '9cbe0ae7-f8d0-4e2f-b97c-d5412e65a612';
  const vmxSignal = { company_name: 'Example Vet', industry: 'animal health', signal_source: 'vmx-2027-exhibitor-list' };
  const store = new MemoryStore();
  store.candidates.push({
    id, identity_key: identityKey(vmxSignal), company_name: vmxSignal.company_name,
    normalized_company_name: 'example vet', signal_payload: vmxSignal, status: 'unresolved',
    attempt_count: 1, next_attempt_at: '2099-01-01T00:00:00.000Z',
  });
  const pipeline = new EmployerDiscoveryPipeline({
    store,
    resolveSource: (input) => resolveOfficialSource(input, {
      searchCareers: (name, options) => searchOfficialCareerCandidates(name, {
        ...options,
        httpFetch: async (url) => String(url).includes('bing.com')
          ? { ok: true, text: async () => '<rss><channel><item><title>Example Vet Careers</title><link>https://examplevet.test/jobs</link><description>Official jobs</description></item></channel></rss>' }
          : { ok: true, text: async () => '<html><body>Transient empty response</body></html>' },
      }),
      readPage: async (url) => {
        if (url === 'https://examplevet.test/jobs') return { url, html: '<title>Example Vet Careers</title><h1>Technical Support Representative</h1><p>Please email your application to jobs@examplevet.test. Support veterinary customers and software.</p>' };
        throw new Error(`fixture 404: ${url}`);
      },
    }),
    validate: async () => ({ ok: true, status: 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS', plausible_job_count: 0, inventory_job_count: 1 }),
  });
  const results = await run(['--force-candidate-id', id, '--limit', '1'], { store, pipeline });
  assert.equal(results[0].status, 'enrolled');
  assert.equal(store.candidates[0].validation_status, 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS');
  assert.equal(store.employers[0].careers_url, 'https://examplevet.test/jobs');
});

test('verified later careers search result is tried after the official homepage and conventional paths fail', async () => {
  const pages = new Map([
    ['https://acmevetsystems.example/', { url: 'https://acmevetsystems.example/', html: '<title>Acme Vet Systems</title><script>window.parentSite="https://acme.example/"</script>' }],
    ['https://careers.acme.example/jobs', { url: 'https://careers.acme.example/jobs', html: '<title>Acme Careers</title><a href="https://boards.greenhouse.io/acme">View open positions</a>' }],
    ['https://boards.greenhouse.io/acme', { url: 'https://boards.greenhouse.io/acme', html: '<h1>Acme jobs</h1>' }],
  ]);
  const result = await resolveOfficialSource({ company_name: 'Acme Vet Systems' }, {
    searchCareers: async () => [
      { url: 'https://acmevetsystems.example/', title: 'Acme Vet Systems', snippet: 'Official site', provider: 'fixture-search' },
      { url: 'https://careers.acme.example/jobs', title: 'Acme Careers and Jobs', snippet: 'Corporate careers', provider: 'fixture-search' },
    ],
    readPage: async (url) => {
      const page = pages.get(url);
      if (!page) throw new Error(`fixture 404: ${url}`);
      return page;
    },
  });
  assert.equal(result.official_url, 'https://acmevetsystems.example/');
  assert.equal(result.configurations[0].ats_type, 'greenhouse');
  assert.ok(result.evidence.provenance_chains.some((chain) => chain.kind === 'verified_public_search_career_result'));
});

test('a supplied verified homepage still runs public careers discovery', async () => {
  const pages = new Map([
    ['https://acmevetsystems.example/', { url: 'https://acmevetsystems.example/', html: '<title>Acme Vet Systems</title><a href="https://acme.example/">Part of Acme</a>' }],
    ['https://careers.acme.example/jobs', { url: 'https://careers.acme.example/jobs', html: '<title>Acme Careers</title><a href="https://boards.greenhouse.io/acme">View jobs</a>' }],
    ['https://boards.greenhouse.io/acme', { url: 'https://boards.greenhouse.io/acme', html: '<h1>Acme jobs</h1>' }],
  ]);
  let searches = 0;
  const result = await resolveOfficialSource({ company_name: 'Acme Vet Systems', company_website: 'https://acmevetsystems.example/' }, {
    searchCareers: async () => {
      searches++;
      return [{ url: 'https://careers.acme.example/jobs', title: 'Acme Careers and Jobs', snippet: 'Corporate careers', provider: 'fixture-search' }];
    },
    readPage: async (url) => {
      const page = pages.get(url);
      if (!page) throw new Error(`fixture 404: ${url}`);
      return page;
    },
  });
  assert.equal(searches, 1);
  assert.equal(result.configurations[0].ats_type, 'greenhouse');
  assert.equal(result.evidence.provenance_chains[0].kind, 'verified_public_search_career_result');
});

test('verified source inventory with zero relevant sales jobs remains a valid source', async () => {
  const configuration = { ats_type: 'custom_html', ats_identifier: 'https://pets.example/careers', source_url: 'https://pets.example/careers' };
  const result = await validateSource(configuration, { id: 'pets', company_name: 'Pets Example', company_website: 'https://pets.example', industry: 'veterinary' }, {
    dispatchSource: async () => ({
      rawJobs: [{ id: 'vet-1' }],
      normalize: () => ({
        source_job_id: 'vet-1', title_original: 'Veterinarian', description_text: 'Provide preventive veterinary care and treatment for companion animals.',
        source_url: 'https://pets.example/careers/veterinarian', status: 'active', source_verified: true,
      }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS');
  assert.equal(result.verified_job_count, 1);
  assert.equal(result.plausible_job_count, 0);
});

test('pipeline prefers a later validated source with relevant jobs over an earlier valid zero-relevant source', async () => {
  const store = new MemoryStore();
  const configurations = [
    { ats_type: 'custom_html', ats_identifier: 'https://pets.example/vet', source_url: 'https://pets.example/vet' },
    { ats_type: 'custom_html', ats_identifier: 'https://pets.example/jobs', source_url: 'https://pets.example/jobs' },
  ];
  const pipeline = new EmployerDiscoveryPipeline({
    store,
    resolveSource: async () => ({ ...resolved(configurations[0]), configurations, careers_pages: configurations.map((item) => item.source_url) }),
    validate: async (configuration) => configuration === configurations[0]
      ? { ok: true, status: 'PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS', plausible_job_count: 0 }
      : { ok: true, status: 'PASS_VALIDATED_SOURCE', plausible_job_count: 2 },
  });
  const result = await pipeline.processSignal(signal);
  assert.equal(result.status, 'enrolled');
  assert.equal(result.employer.ats_identifier, 'https://pets.example/jobs');
  assert.equal(result.validation.plausible_job_count, 2);
});

test('verified official source with an explicit empty inventory remains a valid source', async () => {
  const rawJobs = [];
  rawJobs.authoritativeEmpty = true;
  const result = await validateSource(
    { ats_type: 'custom_html', ats_identifier: 'https://pets.example/careers', source_url: 'https://pets.example/careers' },
    { id: 'pets-empty', company_name: 'Pets Example', company_website: 'https://pets.example', industry: 'veterinary' },
    { dispatchSource: async () => ({ rawJobs, normalize: () => { throw new Error('must not normalize an empty inventory'); } }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'PASS_VALIDATED_SOURCE_EMPTY_INVENTORY');
  assert.equal(result.inventory_job_count, 0);
  assert.equal(result.plausible_job_count, 0);
});

test('embedded public job API is a bounded custom-html fallback and never enables disappearance closures', async () => {
  const apiUrl = 'https://tenant.joveo.site/jobs-api/v2/clients/client1/jobs/search';
  const calls = [];
  const jobs = await fetchCustomHtmlJobs({
    id: 'banfield-like', company_name: 'Banfield-like', company_website: 'https://jobs.example',
    careers_url: 'https://jobs.example/jobs', ats_type: 'custom_html', ats_identifier: 'https://jobs.example/jobs',
  }, {
    fetchPage: async () => `<script>fetch("${apiUrl}")</script>`,
    postJson: async (_url, body) => {
      calls.push(body.searchTerm);
      if (!body.searchTerm) return { totalRecords: 25, totalPages: 25, records: [{ id: 'vet-1', title: 'Veterinarian', description: 'A'.repeat(150), status: 'OPEN', active: true, urlSlug: 'veterinarian' }] };
      if (body.searchTerm === 'sales') return { totalRecords: 1, totalPages: 1, records: [{ id: 'sales-1', title: 'Territory Sales Manager', description: 'B'.repeat(150), status: 'OPEN', active: true, urlSlug: 'territory-sales-manager' }] };
      if (body.searchTerm === 'veterinary') return { totalRecords: 1200, totalPages: 12, records: [{ id: 'vet-2', title: 'Veterinarian', description: 'C'.repeat(150), status: 'OPEN', active: true, urlSlug: 'veterinarian-2' }] };
      return { totalRecords: 0, totalPages: 1, records: [] };
    },
  });
  assert.equal(jobs.inventoryCount, 25);
  assert.equal(jobs.sourceRelevantCount, 1);
  assert.equal(jobs[0].title, 'Territory Sales Manager');
  assert.equal(jobs.incompleteSnapshot, true);
  assert.ok(jobs.snapshotWarnings.length);
  assert.ok(jobs.snapshotWarnings.some((warning) => warning.includes('sampled')));
  assert.ok(calls.includes(''));
});
