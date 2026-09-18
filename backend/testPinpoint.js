const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchPinpointJobs, normalizePinpointJob, pinpointHost } = require('./adapters/pinpoint');

test('pinpointHost: bare subdomain gets the branded pinpointhq.com suffix', () => {
  assert.equal(pinpointHost('exactech'), 'exactech.pinpointhq.com');
});

test('pinpointHost: a full custom hostname (contains a dot) is used as-is — Align Technology CNAMEs its own domain onto Pinpoint', () => {
  assert.equal(pinpointHost('jobs.aligntech.com'), 'jobs.aligntech.com');
});

test('fetchPinpointJobs requests postings.json at the custom-domain host when ats_identifier is a full hostname', async () => {
  const real = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [{ id: 1, title: 'Territory Sales Manager', location: { name: 'Remote, US' }, link: 'https://jobs.aligntech.com/jobs/1' }] };
  };
  try {
    const jobs = await fetchPinpointJobs('jobs.aligntech.com');
    assert.equal(requestedUrl, 'https://jobs.aligntech.com/postings.json');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Territory Sales Manager');
  } finally {
    global.fetch = real;
  }
});

test('fetchPinpointJobs still requests the branded subdomain when ats_identifier is a bare slug (no regression)', async () => {
  const real = global.fetch;
  let requestedUrl = null;
  global.fetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => [] };
  };
  try {
    await fetchPinpointJobs('exactech');
    assert.equal(requestedUrl, 'https://exactech.pinpointhq.com/postings.json');
  } finally {
    global.fetch = real;
  }
});

test('normalizePinpointJob falls back to the correct host (custom domain) when a posting has no link/url of its own', () => {
  const row = normalizePinpointJob({ id: 2, title: 'Account Executive' }, { ats_identifier: 'jobs.aligntech.com' });
  assert.equal(row.source_url, 'https://jobs.aligntech.com');
});

test('fetchPinpointJobs surfaces a non-ok response as an error rather than a false empty result', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
  try {
    await assert.rejects(fetchPinpointJobs('jobs.aligntech.com'), /404/);
  } finally {
    global.fetch = real;
  }
});
