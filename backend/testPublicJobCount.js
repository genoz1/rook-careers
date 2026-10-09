const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public-job-count exposes inventory total and 7-day first_seen intake', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routes/jobs.js'), 'utf8');
  const route = src.slice(src.indexOf('router.get("/public-job-count"'), src.indexOf('router.get("/public-live-finds"'));
  assert.match(route, /new_last_7_days/);
  assert.match(route, /first_seen_at/);
  assert.match(route, /7 \* 86400000/);
  assert.match(route, /total_count/);
  assert.match(route, /linkedin_not_on_pct/);
  assert.match(route, /linkedin_checked_last_7_days/);
  assert.match(route, /linkedin_not_on_last_7_days/);
  assert.match(route, /linkedin_presence->>status\.eq\.not_on_linkedin/);
  assert.match(route, /linkedin_presence->>status\.eq\.possible/);
});

test('public-live-finds returns masked recent career-site finds', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routes/jobs.js'), 'utf8');
  const route = src.slice(src.indexOf('router.get("/public-live-finds"'), src.indexOf('router.get("/public-featured-jobs"'));
  assert.match(route, /employer_hidden:\s*true/);
  assert.match(route, /generalizedRole/);
  assert.match(route, /safeLocationLabel/);
  assert.match(route, /found_ago_label/);
  assert.doesNotMatch(route, /company_name/);
});

test('homepage renders a dynamic 7-day new-jobs stat in the hero', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const heroEnd = html.indexOf('class="trustrow"');
  const hero = html.slice(html.indexOf('class="hero"'), heroEnd > -1 ? heroEnd : html.length);
  assert.match(hero, /id="statNewJobs7d"/);
  assert.match(hero, /class="hero-fresh"/);
  assert.match(hero, /new jobs added in the past 7 days/);
  assert.match(html, /new_last_7_days/);
  assert.match(html, /linkedin_not_on_pct/);
  assert.match(html, /id="liveFindsList"/);
  assert.match(html, /public-live-finds/);
});

test('dashboard and search expose Not on LinkedIn filter', () => {
  const dash = fs.readFileSync(path.join(__dirname, '../public/rook-dashboard-v8.html'), 'utf8');
  const search = fs.readFileSync(path.join(__dirname, '../public/rook-search.html'), 'utf8');
  assert.match(dash, /setTierFilter\('not_on_linkedin'/);
  assert.match(dash, /linkedin_not_on_linkedin/);
  assert.match(search, /id="notOnLinkedInFilter"/);
  assert.match(search, /notOnLinkedInFilter/);
});
