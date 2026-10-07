const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EmployerDiscoveryPipeline } = require('./discovery/pipeline');
const { resolveOfficialSource, detectFromUrl, detectSourceConfigurations } = require('./discovery/sourceResolver');
const { plausibleJob, validateSource } = require('./discovery/sourceValidator');
const { parseInput } = require('./runEmployerDiscovery');

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
      Object.assign(existing, {
        last_signal_at: row.last_signal_at,
        signal_payload: { ...existing.signal_payload, ...row.signal_payload },
        company_website: row.company_website || existing.company_website,
        careers_url: row.careers_url || existing.careers_url,
        job_url: row.job_url || existing.job_url,
      });
      return { candidate: { ...existing }, duplicate: true };
    }
    const candidate = { id: `candidate-${this.candidates.length + 1}`, attempt_count: 0, ...row };
    this.candidates.push(candidate);
    return { candidate: { ...candidate }, duplicate: false };
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
      } }),
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
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: (input) => resolveOfficialSource(input, { readPage: async (url) => pages.get(url) }), validate: passValidation });
  const result = await pipeline.processSignal({ ...signal, careers_url: 'https://acmemedical.example/careers', job_url: null });
  assert.equal(result.status, 'unresolved');
  assert.equal(store.enrollCalls, 0);
  assert.equal(store.candidates[0].validation_status, 'UNSUPPORTED_SOURCE');
  assert.ok(store.candidates[0].next_attempt_at);
  assert.deepEqual(store.candidates[0].evidence.attempted_pages, ['https://acmemedical.example/careers']);
});

test('a supplied website that does not corroborate the company identity is not treated as official', async () => {
  const pages = new Map([
    ['https://unrelated.example/', { url: 'https://unrelated.example/', html: '<title>Unrelated Software</title><a href="https://boards.greenhouse.io/unrelated">Careers</a>' }],
  ]);
  const store = new MemoryStore();
  const pipeline = new EmployerDiscoveryPipeline({ store, resolveSource: (input) => resolveOfficialSource(input, { readPage: async (url) => pages.get(url) || pages.get(`${url}/`) }), validate: passValidation });
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
