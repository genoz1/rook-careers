const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { validateJobFresh, provePublicUrlValid } = require('./socialPublishWorker');

test('public validation uses server-side eligibility when anonymous table access is denied', async () => {
  const job = { id: 'job-1', title_original: 'Territory Sales Manager',
    location_raw: 'Atlanta, GA', state: 'GA', job_lat: 33.75, job_lng: -84.39, status: 'active',
    moderation_status: 'approved', social_eligible: true,
    last_seen_at: new Date().toISOString(), company_name: 'Acme Diagnostics',
    ai_analysis: { required_industries: ['Medical Device'] } };
  const admin = { from(table) {
    const query = { select() { return query; }, eq() { return query; },
      maybeSingle: async () => ({data: job, error: null}),
      then: resolve => resolve({data: [], error: null}) };
    return query;
  } };
  const anon = { from() { throw Error('Raw anonymous table reads are denied'); } };
  const result = await validateJobFresh(admin, anon, job.id, {brandedTerms: [], freshnessWindowDays: 3});
  assert.equal(result.public_url_valid, true);
  assert.equal(result.reason_codes.includes('invalid_public_url'), false);
  job.location_raw = 'Wuhan, China'; job.state = null;
  assert.equal(await provePublicUrlValid(admin, job.id), false);
});

test('social worker finishes a no-op without keeping the process alive', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-09-23T06:00:00Z'])); }
    };
    process.argv = [process.execPath, './backend/socialPublishWorker.js', 'scheduled-dispatch'];
    require('node:module').runMain();
  `], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no-op/);
});
