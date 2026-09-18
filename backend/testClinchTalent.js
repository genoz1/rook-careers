const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchClinchTalentJobs, normalizeClinchTalentJob } = require('./adapters/clinchtalent');

const employer = { id: 'bio-rad', company_name: 'Bio-Rad Laboratories', ats_identifier: 'careers.bio-rad.com' };

// Modeled on the real, confirmed-live structure of careers.bio-rad.com
// this session (WebFetch confirmed Clinch Talent branding, /jobs/search
// pagination, /jobs/{slug} detail links, and real titles including
// "Sales Account Manager" and "CDG Inside Sales Representative") — not a
// byte download, this sandbox can't reach bio-rad.com directly.
function page1() {
  return `<html><body><div class="results">
    <a href="/jobs/sales-account-manager-f-m-d-muenchen-bayern-germany">Sales Account Manager (f/m/d)</a>
    <a href="/jobs/cdg-inside-sales-representative-hercules-ca">CDG Inside Sales Representative</a>
    <a href="/jobs/software-engineer-agentic-ml-hercules-ca">Software Engineer (Agentic/ML)</a>
  </div></body></html>`;
}
function page2() {
  return `<html><body><div class="results">
    <a href="/jobs/senior-service-admin-irvine-ca">Senior Service Admin</a>
  </div></body></html>`;
}
function detailPage(title) {
  return `<html><body><section class="description"><p>${title} role at Bio-Rad. We are hiring for this territory-based position.</p></section></body></html>`;
}

function fetchPage(url) {
  const map = {
    'https://careers.bio-rad.com/jobs/search': page1(),
    'https://careers.bio-rad.com/jobs/search?page=2': page2(),
    'https://careers.bio-rad.com/jobs/search?page=3': '<html><body></body></html>', // no more results — pagination stops
    'https://careers.bio-rad.com/jobs/sales-account-manager-f-m-d-muenchen-bayern-germany': detailPage('Sales Account Manager'),
    'https://careers.bio-rad.com/jobs/cdg-inside-sales-representative-hercules-ca': detailPage('CDG Inside Sales Representative'),
  };
  if (!(url in map)) throw new Error(`unexpected fetch: ${url}`);
  return Promise.resolve({ ok: true, text: async () => map[url] });
}

test('ClinchTalent: pagination walks until an empty page, dedups, and relevance-filters before fetching descriptions', async () => {
  const real = global.fetch;
  global.fetch = async (url) => fetchPage(String(url));
  try {
    const jobs = await fetchClinchTalentJobs('careers.bio-rad.com');
    // Only the 2 sales-relevant titles get detail-fetched and returned —
    // "Software Engineer" and "Senior Service Admin" are excluded by the
    // shared relevance filter before any detail page is even requested.
    assert.equal(jobs.length, 2);
    const titles = jobs.map((j) => j.title).sort();
    assert.deepEqual(titles, ['CDG Inside Sales Representative', 'Sales Account Manager (f/m/d)']);

    const row = normalizeClinchTalentJob(jobs.find((j) => j.title.startsWith('CDG')), employer);
    assert.equal(row.source_url, 'https://careers.bio-rad.com/jobs/cdg-inside-sales-representative-hercules-ca');
    assert.equal(row.status, 'active');
    assert.equal(row.source_verified, true);
    // Known, deliberate limitation (see clinchtalent.js header): location
    // is not parsed from the list page. This test documents that gap
    // rather than hiding it — flagged in this round's report as a real
    // location-integrity limitation to fix with real page source, not
    // guessed at blind.
    assert.equal(row.location_raw, '');
  } finally {
    global.fetch = real;
  }
});

test('ClinchTalent refresh safety: a non-ok response on page 1 throws rather than returning a false empty result (would otherwise close every existing job)', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' });
  try {
    await assert.rejects(fetchClinchTalentJobs('careers.bio-rad.com'), /503/);
  } finally {
    global.fetch = real;
  }
});

test('ClinchTalent refresh safety: zero job links on page 1 with no explicit empty-results text throws instead of reporting a false empty snapshot', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '<html><body><div id="cookie-banner">Accept cookies</div></body></html>' });
  try {
    await assert.rejects(fetchClinchTalentJobs('careers.bio-rad.com'), /no job links and no explicit empty-results text/);
  } finally {
    global.fetch = real;
  }
});

test('ClinchTalent refresh safety: explicit "no open positions" text on page 1 is accepted as a genuine empty result', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '<html><body><p>There are no open positions matching your search.</p></body></html>' });
  try {
    const jobs = await fetchClinchTalentJobs('careers.bio-rad.com');
    assert.deepEqual(jobs, []);
  } finally {
    global.fetch = real;
  }
});

test('ClinchTalent: a later page (page 2+) failing does not invalidate rows already collected from page 1', async () => {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://careers.bio-rad.com/jobs/search') {
      return { ok: true, text: async () => '<a href="/jobs/sales-account-manager-hercules-ca">Sales Account Manager</a>' };
    }
    if (u === 'https://careers.bio-rad.com/jobs/search?page=2') return { ok: false, status: 500, statusText: 'Error', text: async () => '' };
    if (u === 'https://careers.bio-rad.com/jobs/sales-account-manager-hercules-ca') {
      return { ok: true, text: async () => '<html><body><section class="description">Sales role</section></body></html>' };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try {
    const jobs = await fetchClinchTalentJobs('careers.bio-rad.com');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Sales Account Manager');
  } finally {
    global.fetch = real;
  }
});
