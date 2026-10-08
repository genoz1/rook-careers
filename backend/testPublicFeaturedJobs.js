const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generalizedRole, safeLocationLabel, freshness } = require('./maskedPresentation');

test('public-featured-jobs is a slim cached marketing endpoint', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routes/jobs.js'), 'utf8');
  const start = src.indexOf('// GET /api/public-featured-jobs');
  const end = src.indexOf('router.get("/public-employer-count"');
  assert.ok(start > -1 && end > start);
  const route = src.slice(start, end);
  assert.match(route, /FEATURED_JOB_SELECT/);
  assert.match(route, /first_seen_at/);
  assert.match(route, /fetchRecentFeaturedPool\(24\)/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /featuredJobsCacheMap|FEATURED_JOBS_TTL/);
  assert.match(route, /req\.query\.zip/);
  assert.match(route, /near_lat/);
  assert.match(route, /FEATURED_NEAR_RADIUS_MILES/);
  assert.match(route, /fetchNearbyFeaturedPool/);
  assert.doesNotMatch(route, /description_text/);
  assert.doesNotMatch(route, /company_name/);
});

test('homepage hydrates featured jobs without blocking on full inventory', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="featuredJobsGrid"/);
  assert.match(html, /\/api\/public-featured-jobs/);
  assert.match(html, /id="jobsZipForm"/);
  assert.match(html, /id="membership"/);
  assert.match(html, /Job boards make you search/);
  assert.match(html, /Takes about 2 minutes/);
  assert.match(html, /rook-onboarding-v8\.html" class="view-btn"/);
  assert.doesNotMatch(html, /public-employer-count/);
});

test('featured job projection stays within public masking helpers', () => {
  const job = {
    title_original: 'Acme Diagnostics Territory Manager - Southeast',
    title_normalized: 'Territory Manager',
    city: 'Tampa',
    state: 'FL',
    territory: 'regional',
    first_seen_at: new Date().toISOString(),
    ai_analysis: { product_categories: ['laboratory diagnostics'], market_industries: ['Diagnostics'] },
    category: 'Diagnostics',
    sales_type: 'field sales',
  };
  const role = generalizedRole(job);
  const location = safeLocationLabel(job);
  assert.ok(role && !/acme/i.test(role));
  assert.ok(location);
  assert.ok(freshness(job, Date.now(), true));
});
