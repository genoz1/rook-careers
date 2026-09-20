const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const classification = require('../public/rook-job-classification');

const root = path.join(__dirname, '..');
const searchHtml = fs.readFileSync(path.join(root, 'public/rook-search.html'), 'utf8');
const jobsRoute = fs.readFileSync(path.join(root, 'backend/routes/jobs.js'), 'utf8');
const mobileMenu = fs.readFileSync(path.join(root, 'public/rook-mobile-menu.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(root, 'public/rook-dashboard.html'), 'utf8');
const dashboardV7Html = fs.readFileSync(path.join(root, 'public/rook-dashboard-v7.html'), 'utf8');
const productTourJs = fs.readFileSync(path.join(root, 'public/rook-product-tour.js'), 'utf8');

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

test('finite radius is exact and mobile keeps the location and distance controls in the open filter panel', () => {
  assert.match(searchHtml, /nearLocationCoords && radiusMiles > 0/);
  assert.match(searchHtml, /job\.job_lat == null \|\| job\.job_lng == null\)[\s\S]{0,220}return false/);
  assert.match(searchHtml, /#desktopLocationFilterGroup\{display:block;\}/);
  assert.match(searchHtml, /id="desktopLocationFilterGroup"/);
  assert.match(searchHtml, /\.filters,\.filters\.mobile-open\{display:block;/);
  assert.match(searchHtml, /\.mobile-filters-toggle,\.mobile-zip-row\{display:none !important;\}/);
  assert.match(searchHtml, /Jobs without exact coordinates are excluded/);
});

test('nearest is the default Job Search sort', () => {
  assert.match(searchHtml, /<option value="closest" selected>Nearest<\/option>/);
  assert.match(searchHtml, /document\.getElementById\('sortSelect'\)\.value = 'closest'/);
});

test('mobile result controls cannot force horizontal overflow', () => {
  assert.match(searchHtml, /\.mobile-zip-input\{[\s\S]{0,100}min-width:0/);
  assert.match(searchHtml, /\.results-count\{width:100%;\}/);
  assert.match(searchHtml, /\.sort-row\{width:100%; min-width:0;/);
  assert.match(searchHtml, /\.sort-row select\{flex:1; min-width:0; max-width:100%;\}/);
});

test('mobile search filters are always visible in one panel', () => {
  assert.match(searchHtml, /<h3>Search &amp; Filters<\/h3>/);
  assert.match(searchHtml, /\.filters-column\{display:block; width:100%;\}/);
  assert.match(searchHtml, /<label>ZIP code or city<\/label>/);
});

test('desktop search grid fills the available shell instead of centering a shrink-wrapped panel', () => {
  assert.match(searchHtml, /\.layout\{width:100%; max-width:1320px;/);
});

test('Dashboard and Job Search explain their distinct purposes and cross-link', () => {
  assert.match(searchHtml, /Job Search:<\/strong> Search all active ROOK jobs by company, location, distance, or industry/);
  assert.match(searchHtml, /Want personalized recommendations\? View Dashboard/);
  assert.match(dashboardHtml, /Dashboard:<\/strong> Personalized job recommendations ranked for your profile and preferences/);
  assert.match(dashboardHtml, /Looking for a specific company, location, or industry\? Use Job Search/);
});

test('first-sign-in product tour distinguishes Dashboard, Job Search, and Saved Jobs', () => {
  assert.match(dashboardHtml, /id="rookProductTour"/);
  assert.match(dashboardHtml, /rook_product_tour_completed/);
  assert.match(dashboardHtml, /These are personalized recommendations ranked against your profile and preferences/);
  assert.match(dashboardHtml, /Search ROOK’s complete active-job database by company, location, distance, or industry/);
  assert.match(dashboardHtml, /Save promising roles here/);
  assert.match(dashboardHtml, /rookSupabase\.auth\.updateUser/);
  assert.match(dashboardHtml, /id="rookTourSkip"/);
  assert.match(dashboardHtml, /id="rookTourBack"/);
  assert.match(dashboardHtml, /id="rookTourNext"/);
});

test('the actual first masked dashboard loads the once-per-account product tour', () => {
  assert.match(dashboardV7Html, /src="rook-product-tour\.js"/);
  assert.match(productTourJs, /rook_product_tour_completed/);
  assert.match(productTourJs, /rookSupabase\.auth\.getUser/);
  assert.match(productTourJs, /rookSupabase\.auth\.updateUser/);
  assert.match(productTourJs, /Step \$\{index \+ 1\} of \$\{steps\.length\}/);
});

test('sparse compensation and default-zero travel data do not expose misleading filters', () => {
  assert.match(jobsRoute, /Number\(job\.travel_percentage\) > 0/);
  assert.match(searchHtml, /count \/ Math\.max\(1, Number\(totalCount\) \|\| 0\) >= 0\.05/);
  assert.match(searchHtml, /meaningfulCoverage\(coverage\.compensation\)/);
  assert.match(searchHtml, /meaningfulCoverage\(coverage\.travel\)/);
});
