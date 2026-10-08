const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public-job-count exposes inventory total and 7-day first_seen intake', () => {
  const src = fs.readFileSync(path.join(__dirname, 'routes/jobs.js'), 'utf8');
  const route = src.slice(src.indexOf('router.get("/public-job-count"'), src.indexOf('router.get("/public-employer-count"'));
  assert.match(route, /new_last_7_days/);
  assert.match(route, /first_seen_at/);
  assert.match(route, /7 \* 86400000/);
  assert.match(route, /total_count/);
});

test('homepage renders a dynamic 7-day new-jobs stat', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="statNewJobs7d"/);
  assert.match(html, /New jobs added in the past 7 days/);
  assert.match(html, /new_last_7_days/);
});
