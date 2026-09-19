const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const classification = require('../public/rook-job-classification');

const root = path.join(__dirname, '..');
const searchHtml = fs.readFileSync(path.join(root, 'public/rook-search.html'), 'utf8');
const jobsRoute = fs.readFileSync(path.join(root, 'backend/routes/jobs.js'), 'utf8');
const mobileMenu = fs.readFileSync(path.join(root, 'public/rook-mobile-menu.html'), 'utf8');

test('Job Search uses its own unscored full-catalog endpoint', () => {
  assert.match(searchHtml, /rookApiFetch\('\/job-search\?'/);
  assert.doesNotMatch(searchHtml, /id="filterMatchScore"/);
  assert.doesNotMatch(searchHtml, />Best Match</);
  const route = jobsRoute.slice(jobsRoute.indexOf('router.get("/job-search"'), jobsRoute.indexOf('// GET /api/jobs?'));
  assert.match(route, /eq\("status", "active"\)/);
  assert.match(route, /eq\("moderation_status", "approved"\)/);
  assert.match(route, /company_name\.ilike/);
  assert.doesNotMatch(route, /scoreJob|candidate_job_matches.*select\(".*overall_score|300/);
  assert.match(route, /scored: false/);
});

test('all visible industry values map to the canonical classifier', () => {
  const options = [...searchHtml.matchAll(/class="filter-industry" value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options, ['Diagnostics', 'Veterinary', 'Medical Device', 'Capital Equipment', 'Pharmaceutical']);
  for (const option of options) {
    const job = { ai_analysis: { product_categories: [option], market_industries: [], required_customer_types: [] } };
    assert.equal(classification.matches(job, [option]), true, option);
  }
});

test('mobile navigation calls catalog search Job Search and keeps Dashboard distinct', () => {
  assert.match(mobileMenu, /href="rook-dashboard\.html">\s*Dashboard/);
  assert.match(mobileMenu, /href="rook-search\.html">\s*Job Search/);
  assert.doesNotMatch(mobileMenu, /href="rook-search\.html">\s*My Matches/);
  const memberSection = mobileMenu.slice(mobileMenu.indexOf('id="memberPanel"'), mobileMenu.indexOf('id="publicPanel"'));
  assert.doesNotMatch(memberSection, /href="rook-browse\.html"/);
});

test('Any distance has no hidden geographic cutoff in catalog route', () => {
  const route = jobsRoute.slice(jobsRoute.indexOf('router.get("/job-search"'), jobsRoute.indexOf('// GET /api/jobs?'));
  assert.doesNotMatch(route, /EXPLORE_RADIUS|latDelta|lngDelta|distanceMiles\([^)]*\)\s*[<>]=?\s*300/);
  assert.match(searchHtml, /nearLocationCoords && radiusMiles > 0/);
});

test('finite radius is exact and mobile shows only one location control', () => {
  assert.match(searchHtml, /nearLocationCoords && radiusMiles > 0/);
  assert.match(searchHtml, /job\.job_lat == null \|\| job\.job_lng == null\)[\s\S]{0,220}return false/);
  assert.match(searchHtml, /#desktopLocationFilterGroup\{display:none;\}/);
  assert.match(searchHtml, /id="desktopLocationFilterGroup"/);
});
