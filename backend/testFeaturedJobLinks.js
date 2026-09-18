const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const eligibility = require('./jobEligibility');

// Project database rows through the actual requested columns so missing
// eligibility fields reproduce the public-page regression.
function database(row, error = null) {
  return { from() {
    let columns;
    const filters = [];
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      neq() { return query; }, limit() { return query; }, ilike() { return query; },
      then(resolve) { resolve({ data: [], error: null }); },
      async maybeSingle() {
        const matches = row && filters.every(([key, value]) => row[key] === value);
        return { error, data: matches ? Object.fromEntries(columns.split(',').map(s => s.trim()).map(key => [key, row[key]])) : null };
      },
    };
    return query;
  } };
}

function load(file, db) {
  const routes = {};
  const router = { get(route, handler) { routes[route] = handler; } };
  const module = { exports: {} };
  const requireStub = name => {
    if (name === 'express') return { Router: () => router };
    if (name === '@supabase/supabase-js') return { createClient: () => db };
    if (name === 'dotenv') return { config() {} };
    if (name.endsWith('/jobEligibility')) return eligibility;
    if (name === '../routes/stripe') return { getTrialPeriodDays: () => 3 };
    return {};
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module, require: requireStub,
    process: { env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'test' } },
    console, URL, URLSearchParams,
  }, { filename: file });
  return { routes, exports: module.exports };
}

async function check(row, expectedStatus, expectedPublishable, error = null) {
  const db = database(row, error);
  const { routes } = load('routes/publicPages.js', db);
  let status = 200, html = '';
  const res = { status(value) { status = value; return res; }, send(value) { html = value; return res; } };
  await routes['/jobs/:id']({ params: { id: 'sample-job' } }, res, () => assert.fail('Unexpected fallthrough'));
  assert.equal(status, expectedStatus);
  const worker = load('socialPublishWorker.js', db).exports;
  assert.equal(await worker.provePublicUrlValid(db, 'sample-job'), expectedPublishable);
  for (const secret of ['PRIVATE_EMPLOYER_NAME', 'PRIVATE_FULL_DESCRIPTION', 'https://employer.invalid/private-apply', 'PRIVATE_LOCATION_EVIDENCE']) {
    assert.ok(!html.includes(secret), `Public HTML exposed ${secret}`);
  }
  if (expectedStatus === 200) {
    assert.ok(html.includes('Employer revealed with ROOK access'));
    assert.ok(html.includes('ROOK members see the employer'));
    assert.ok(html.includes("status === 'active' || status === 'trialing'"));
  }
}

(async () => {
  const remote = {
    id: 'sample-job', status: 'active', title_original: 'Senior Consultant', location_raw: 'Remote',
    location_evidence: { source_country_code: 'US', status: 'verified', diagnostic: 'PRIVATE_LOCATION_EVIDENCE' },
    company_name: 'PRIVATE_EMPLOYER_NAME', description_text: 'PRIVATE_FULL_DESCRIPTION',
    application_url: 'https://employer.invalid/private-apply',
  };
  await check(remote, 200, true);
  await check({ ...remote, location_evidence: undefined }, 404, false);
  await check({ ...remote, location_evidence: { source_country_code: 'CA', status: 'foreign' } }, 404, false);
  await check({ ...remote, status: 'closed' }, 404, false);
  await check(null, 404, false);
  await check(remote, 404, false, { message: 'Database unavailable' });
  await check({ ...remote, location_raw: 'Tampa, FL, United States', location_evidence: undefined, job_lat: 27.95, job_lng: -82.46, state: 'FL' }, 200, true);
  console.log('Passed 7 public-page and publishing checks, including masked HTML and access gating.');
})().catch(error => { console.error(error); process.exitCode = 1; });
