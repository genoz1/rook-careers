const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const jobsSource = fs.readFileSync(path.join(__dirname, 'routes/jobs.js'), 'utf8');
const geoSource = fs.readFileSync(path.join(__dirname, 'geoJobPool.js'), 'utf8');
const profileSource = fs.readFileSync(path.join(__dirname, 'routes/profile.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public/rook-dashboard-v8.html'), 'utf8');

test('list responses strip ai_analysis and other unused heavy fields', () => {
  const fn = jobsSource.slice(
    jobsSource.indexOf('function stripUnusedDescriptionFields'),
    jobsSource.indexOf('async function loadEmployerHistory')
  );
  assert.match(fn, /ai_analysis/);
  assert.match(fn, /industry_classification/);
  assert.match(fn, /territory_locations/);
  assert.match(fn, /required_skills/);
  assert.match(fn, /recruiter_email/);
});

test('home and explore /jobs paths overlap pool, status, and employer history', () => {
  assert.match(jobsSource, /Promise\.all\(\[poolPromise, statusPromise, historyPromise\]\)/);
  assert.match(jobsSource, /Promise\.all\(\[\s*fetchGeoScopedJobPool/);
  assert.match(jobsSource, /loadEmployerHistory\(profile\.id\)/);
});

test('geo-scoped box query is capped', () => {
  assert.match(geoSource, /maxBox\s*=\s*700/);
  assert.match(geoSource, /maxAccepted:\s*maxBox/);
  assert.match(geoSource, /maxStateName\s*=\s*300/);
});

test('preference-only profile saves defer background inventory rescore', () => {
  assert.match(profileSource, /preferenceOnly/);
  assert.match(profileSource, /setTimeout\(runRescore,\s*2500\)/);
});

test('dashboard starts /jobs from cached profile without waiting on /profile', () => {
  assert.match(dashboard, /profileHint/);
  assert.match(dashboard, /jobsUrlFor/);
  assert.match(dashboard, /profileHint\?\.home_lat/);
  assert.match(dashboard, /reloadIndustryJobs\(\{ profileHint: saved \}\)/);
  // Checkbox industry filters must not force a full refetch when the pool is already "all".
  const changeFn = dashboard.slice(
    dashboard.indexOf('function changeIndustryFilter()'),
    dashboard.indexOf('function showEveryIndustry()')
  );
  assert.doesNotMatch(changeFn, /reloadIndustryJobs/);
  assert.match(changeFn, /applyRecruiterToggle/);
});
