const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchApplicantProJobs, normalizeApplicantProJob } = require('./adapters/applicantpro');

const employer = { id: 'castle-biosciences', company_name: 'Castle Biosciences', ats_identifier: 'castlebiosciences' };

// Fixtures reflect the live September 23 board contract.
function fetchPage(url) {
  const map = {
    'https://castlebiosciences.applicantpro.com/jobs/': {
      ok: true,
      text: async () => '<html><body><script>var domain_id="482910";</script></body></html>',
    },
    'https://castlebiosciences.applicantpro.com/core/jobs/482910?getParams=%7B%7D': {
      ok: true,
      json: async () => ({
        success: true, data: { jobCount: 2, jobs: [
          { id: 1, title: 'Territory Sales Manager, Dermatology', city: 'Dallas', state: 'TX', jobUrl: 'https://castlebiosciences.applicantpro.com/jobs/1' },
          { id: 2, title: 'Lab Technician', city: 'Friendswood', state: 'TX' },
        ] },
      }),
    },
  };
  if (url === 'https://castlebiosciences.applicantpro.com/jobs/1') return Promise.resolve({ ok: true, headers: new Headers({'content-type':'text/html'}), text: async () => '<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title:'Territory Sales Manager, Dermatology',description:'<p>Sell diagnostic tests to clinicians.</p>'})+'</script>' });
  const entry = map[url];
  if (!entry) throw new Error(`unexpected fetch: ${url}`);
  return Promise.resolve(entry);
}

test('ApplicantPro: two-step domain_id scrape then JSON fetch, relevance-filtered', async () => {
  const real = global.fetch;
  global.fetch = async (url) => fetchPage(String(url));
  try {
    const jobs = await fetchApplicantProJobs('castlebiosciences');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Territory Sales Manager, Dermatology');
    const row = normalizeApplicantProJob(jobs[0], employer);
    assert.equal(row.location_raw, 'Dallas, TX');
    assert.equal(row.status, 'active');
  } finally {
    global.fetch = real;
  }
});

test('ApplicantPro refresh safety: a malformed JSON response (no "jobs" field) throws instead of a false empty snapshot', async () => {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://castlebiosciences.applicantpro.com/jobs/') return fetchPage(u);
    if (u === 'https://castlebiosciences.applicantpro.com/core/jobs/482910?getParams=%7B%7D') {
      return { ok: true, json: async () => ({ error: 'unexpected shape, no jobs key at all' }) };
    }
    throw new Error(`unexpected: ${u}`);
  };
  try {
    await assert.rejects(fetchApplicantProJobs('castlebiosciences'), /unexpected response shape/);
  } finally {
    global.fetch = real;
  }
});

test('ApplicantPro: a genuinely empty "jobs" array (the key is present) is accepted as a real zero-job result', async () => {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://castlebiosciences.applicantpro.com/jobs/') return fetchPage(u);
    if (u === 'https://castlebiosciences.applicantpro.com/core/jobs/482910?getParams=%7B%7D') {
      return { ok: true, json: async () => ({ success: true, data: { jobCount: 0, jobs: [] } }) };
    }
    throw new Error(`unexpected: ${u}`);
  };
  try {
    const jobs = await fetchApplicantProJobs('castlebiosciences');
    assert.equal(jobs.length, 0);
    assert.equal(jobs.incompleteSnapshot, false);
  } finally {
    global.fetch = real;
  }
});

test('ApplicantPro: no domain_id found on the jobs page throws (employer may have migrated off ApplicantPro/isolved)', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '<html><body>nothing here</body></html>' });
  try {
    await assert.rejects(fetchApplicantProJobs('castlebiosciences'), /Could not find a domain_id/);
  } finally {
    global.fetch = real;
  }
});
