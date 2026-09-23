const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  fetchSuccessFactorsJobs,
  normalizeSuccessFactorsJob,
  locationFromDetailUrl,
  locationFromRowText,
  findNextPageUrl,
} = require('./adapters/successfactors');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/successfactors', name + '.html'), 'utf8');
const employer = { id: 'test', company_name: 'Employer', ats_type: 'successfactors' };

// Installs a fake global.fetch keyed by exact URL (search pages) plus a
// catch-all for any /job/.../<id>/ detail URL, and restores the real
// fetch afterwards. Mirrors the same stub-fetch convention already used
// for the (now superseded) customHtml prototype tests.
function withFakeFetch(routes, fn) {
  const real = global.fetch;
  global.fetch = async (url) => {
    const key = String(url);
    if (routes[key]) {
      const body = routes[key];
      return { ok: true, status: 200, statusText: 'OK', text: async () => body };
    }
    if (/\/job\/[^/]+\/\d+\/?$/.test(key)) {
      return { ok: true, status: 200, statusText: 'OK', text: async () => fixture('detail') };
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  };
  return fn().finally(() => {
    global.fetch = real;
  });
}

test('single-page tenant: table skin, location in its own cell, irrelevant title filtered out', async () => {
  await withFakeFetch(
    { 'https://careers.example.com/search/?q=sales': fixture('single-page') },
    async () => {
      const jobs = await fetchSuccessFactorsJobs('careers.example.com');
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].title, 'Territory Manager, Surgical');
      assert.equal(jobs[0].location, 'Boston, MA');
      assert.equal(jobs[1].title, 'Regional Sales Rep');
      assert.equal(jobs[1].location, 'Chicago, IL');
      assert(!jobs.some((j) => j.title === 'Software Engineer II'));
      assert(jobs[0].description.includes('surgical devices'));

      const row = normalizeSuccessFactorsJob(jobs[0], employer, 'careers.example.com');
      assert.equal(row.source_job_id, '1424825633');
      assert.equal(row.status, 'active');
      assert.equal(row.source_verified, true);
      assert.equal(row.location_raw, 'Boston, MA');
    }
  );
});

test('paginated tenant: div skin with no location cell, location falls back to detail-URL slug, both pages combined', async () => {
  await withFakeFetch(
    {
      'https://careers.example.com/search/?q=sales': fixture('page1'),
      'https://careers.example.com/search/?q=sales&startrow=25': fixture('page2'),
    },
    async () => {
      const jobs = await fetchSuccessFactorsJobs('careers.example.com');
      assert.equal(jobs.length, 3);
      assert.equal(jobs[0].title, 'Molecular Account Executive');
      assert.equal(jobs[0].location, 'AUSTIN, TX');
      assert.equal(jobs[1].location, 'Denver, CO');
      assert.equal(jobs[2].title, 'Territory Sales Manager');
      assert.equal(jobs[2].location, 'Seattle, WA');
    }
  );
});

test('explicit "no results" text is a legitimate empty result', async () => {
  await withFakeFetch(
    { 'https://careers.example.com/search/?q=sales': fixture('no-results') },
    async () => {
      const jobs = await fetchSuccessFactorsJobs('careers.example.com');
      assert.deepEqual(jobs, []);
    }
  );
});

test('blocked/JS-only/cookie-wall tenant with no job rows and no explicit empty text throws rather than reporting a false empty success', async () => {
  await withFakeFetch(
    { 'https://careers.example.com/search/?q=sales': fixture('empty') },
    async () => {
      await assert.rejects(
        fetchSuccessFactorsJobs('careers.example.com'),
        /no job rows and no explicit empty-results text/
      );
    }
  );
});

test('a non-ok HTTP response on the first page fails loudly rather than silently returning zero jobs', async () => {
  const real = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' });
  try {
    await assert.rejects(fetchSuccessFactorsJobs('careers.example.com'), /503/);
  } finally {
    global.fetch = real;
  }
});

test('locationFromDetailUrl parses city/state/zip out of the CSB slug format', () => {
  assert.equal(
    locationFromDetailUrl('https://careers.example.com/job/Boston-Territory-Manager%2C-Surgical-MA-02108/1424825633/'),
    'Boston, MA'
  );
  assert.equal(locationFromDetailUrl('https://careers.example.com/job/not-a-real-slug/999/'), null);
  assert.equal(locationFromDetailUrl('https://jobs.boehringer-ingelheim.com/job/Stockton%2C-CA-ILD-Sales-Consultant-Unit/1430585933/'), 'Stockton, CA');
});

test('locationFromRowText finds "City, ST" once the title is stripped from the row text', () => {
  assert.equal(locationFromRowText('Territory Manager, Surgical Boston, MA', 'Territory Manager, Surgical'), 'Boston, MA');
  assert.equal(locationFromRowText('Territory Manager, Surgical', 'Territory Manager, Surgical'), null);
});

test('findNextPageUrl recognizes rel=next and startrow links, and ignores unrelated links', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load('<a href="/about">About</a><a rel="next" href="/search/?q=sales&startrow=25">Next</a>');
  const next = findNextPageUrl($, 'https://careers.example.com/search/?q=sales');
  assert.equal(next, 'https://careers.example.com/search/?q=sales&startrow=25');
});

test('findNextPageUrl walks sequentially instead of jumping to the CSB last-page link', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load('<ul class="pagination"><li><a href="?q=sales&amp;startrow=25" title="Page 2">2</a></li><li><a class="paginationItemLast" href="?q=sales&amp;startrow=475" title="Last Page"><span>»</span></a></li></ul>');
  assert.equal(findNextPageUrl($, 'https://careers.example.com/search/?q=sales'), 'https://careers.example.com/search/?q=sales&startrow=25');
});

test('ingestion dispatcher compatibility: normalize signature matches ingest.js call shape (job, employer, host)', () => {
  const raw = { title: 'Territory Manager', detailUrl: 'https://careers.example.com/job/x-MA-02108/42/', location: 'Boston, MA', description: 'desc' };
  const row = normalizeSuccessFactorsJob(raw, { id: 'e1', company_name: 'Acme' }, 'careers.example.com');
  assert.equal(row.employer_id, 'e1');
  assert.equal(row.source_type, 'successfactors');
  assert.equal(row.application_url, raw.detailUrl);
});


test('structured foreign country survives detail extraction and failed details forbid closures', async () => {
  const listing = '<a href="/job/Test/123/">Territory Sales Manager</a>';
  await withFakeFetch({
    'https://careers.example.com/search/?q=sales': listing,
    'https://careers.example.com/job/Test/123/': '<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',description:'<p>Sell diagnostic products</p>',jobLocation:{address:{addressLocality:'Shanghai',addressCountry:'China'}}})+'</script>'
  }, async () => {
    const jobs = await fetchSuccessFactorsJobs('careers.example.com');
    assert.equal(jobs[0].location, 'Shanghai, China');
    assert.equal(jobs.incompleteSnapshot, false);
  });
  await withFakeFetch({
    'https://careers.example.com/search/?q=sales': listing,
    'https://careers.example.com/job/Test/123/': '<html>Sign in</html>'
  }, async () => {
    const jobs = await fetchSuccessFactorsJobs('careers.example.com');
    assert.equal(jobs.length, 0);
    assert.equal(jobs.incompleteSnapshot, true);
  });
});
