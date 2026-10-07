const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchVmxCompanies, websiteFromVmxProfile, dedupeCompanies, discoverCompanyFirstSignals } = require('./discovery/companySources');
const { parseArgs, inspectSignals, isValidatedSourceStatus, run } = require('./runCompanyDiscovery');

function response(body, { url = 'https://example.test', headers = {} } = {}) {
  return { ok: true, status: 200, url, headers: { getSetCookie: () => headers.cookies || [], get: () => null }, text: async () => String(body), json: async () => body };
}

test('official VMX directory returns commercial company-first candidates', async () => {
  const calls = [];
  const httpFetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return response('<html/>', { headers: { cookies: ['CFID=abc; path=/', 'CFTOKEN=def; path=/'] } });
    return response({ SUCCESS: true, DATA: { totalhits: 3, results: { exhibitor: { hit: [
      { fields: { exhid_l: 1, exhname_t: 'Acme Vet Diagnostics', exhdesc_t: 'Veterinary diagnostic equipment manufacturer' } },
      { fields: { exhid_l: 2, exhname_t: 'State Veterinary Association', exhdesc_t: 'Membership association' } },
      { fields: { exhid_l: 3, exhname_t: 'Generic Booth', exhdesc_t: 'Unrelated organization' } },
    ] } } } });
  };
  const result = await fetchVmxCompanies({ httpFetch });
  assert.equal(result.total_listed, 3);
  assert.deepEqual(result.companies.map((item) => item.company_name), ['Acme Vet Diagnostics']);
  assert.equal(result.companies[0].signal_source, 'vmx-2027-official-directory');
});

test('VMX profile website is accepted only through official profile evidence', async () => {
  const company = { directory_url: 'https://vmx.example/exhibitor/1', source_cookie: 'CFID=x' };
  const found = await websiteFromVmxProfile(company, { httpFetch: async () => response('websiteValue: "https:\\/\\/acmevet.example\\/"') });
  assert.equal(found.website, 'https://acmevet.example/');
});

test('catalog deduplication and known-employer accounting happen before enrichment', async () => {
  const result = await discoverCompanyFirstSignals({
    knownEmployers: [{ company_name: 'Known Vet Co' }], limit: 5, includeCurated: false,
    httpFetch: async (url) => url.includes('exhibitor-gallery')
      ? response('<html/>', { headers: { cookies: ['CFID=x; path=/'] } })
      : url.includes('remote-proxy')
        ? response({ SUCCESS: true, DATA: { totalhits: 3, results: { exhibitor: { hit: [
          { fields: { exhid_l: 1, exhname_t: 'Known Vet Co', exhdesc_t: 'Medical device manufacturer' } },
          { fields: { exhid_l: 2, exhname_t: 'New Vet Co', exhdesc_t: 'Animal health technology supplier' } },
          { fields: { exhid_l: 3, exhname_t: 'New Vet Co Inc.', exhdesc_t: 'Animal health products' } },
        ] } } } })
        : response('websiteValue: "https:\\/\\/newvet.example\\/"'),
    resolveWebsite: async () => null,
  });
  assert.equal(result.stats.catalog_companies, 2);
  assert.equal(result.stats.already_monitored, 1);
  assert.equal(result.stats.genuinely_new, 1);
  assert.equal(result.stats.official_websites_resolved, 1);
});

test('shadow inspection detects and validates ATS sources without enrolling', async () => {
  const inspected = await inspectSignals([{ company_name: 'Acme', company_website: 'https://acme.example' }], {
    resolveSource: async () => ({ official_url: 'https://acme.example/', careers_pages: ['https://acme.example/careers'], configurations: [{ ats_type: 'greenhouse', ats_identifier: 'acme' }] }),
    validate: async () => ({ ok: true, status: 'PASS_VALIDATED_SOURCE', plausible_job_count: 2 }),
  });
  assert.equal(inspected[0].status, 'validated');
  assert.equal(inspected[0].plausible_job_count, 2);
});

test('runner is bounded and apply mode uses the Phase 2 pipeline', async () => {
  assert.throws(() => parseArgs([]), /--shadow or --apply/);
  assert.throws(() => parseArgs(['--shadow', '--limit', '30']), /1 to 25/);
  let processed = 0;
  const summary = await run(['--apply', '--limit', '2'], {
    store: { listEmployers: async () => [] },
    discoverSignals: async () => ({ stats: { catalog_companies: 2 }, signals: [{ company_name: 'A' }, { company_name: 'B' }] }),
    pipeline: { processSignal: async (signal) => { processed++; return { status: signal.company_name === 'A' ? 'enrolled' : 'unresolved', candidate: { id: signal.company_name, validation_status: signal.company_name === 'A' ? 'PASS_VALIDATED_SOURCE' : 'NEEDS_OFFICIAL_DOMAIN' }, employer: signal.company_name === 'A' ? { id: 'e1', ats_type: 'greenhouse' } : null, validation: signal.company_name === 'A' ? { status: 'PASS_VALIDATED_SOURCE', plausible_job_count: 1 } : null }; } },
  });
  assert.equal(processed, 2);
  assert.equal(summary.automatically_enrolled, 1);
  assert.equal(summary.unresolved, 1);
});

test('validated-source status variants are counted as machine validated', () => {
  assert.equal(isValidatedSourceStatus('PASS_VALIDATED_SOURCE'), true);
  assert.equal(isValidatedSourceStatus('PASS_VALIDATED_SOURCE_EMPTY_INVENTORY'), true);
  assert.equal(isValidatedSourceStatus('PASS_VALIDATED_SOURCE_NO_RELEVANT_JOBS'), true);
  assert.equal(isValidatedSourceStatus('VALIDATION_FAILED'), false);
});
