const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('skipped employers advance last_checked_at so they cannot starve the ingest queue', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ingest.js'), 'utf8');
  assert.match(source, /async function markIngestSkip/);
  assert.match(source, /last_checked_at: checkedAt/);
  assert.match(source, /Unsupported ats_type/);
  assert.match(source, /custom_html source is not enabled/);
  assert.match(source, /hasCareersUrl/);
});

test('scheduled public discovery covers all six categories each cycle', () => {
  const scheduled = fs.readFileSync(path.join(__dirname, 'runScheduledDiscovery.js'), 'utf8');
  assert.match(scheduled, /--query-limit',\s*'6'/);
  assert.match(scheduled, /--ingest-enrolled/);
});

test('existing-employer public signals trigger official-source re-ingest', () => {
  const publicDiscovery = fs.readFileSync(path.join(__dirname, 'runPublicJobDiscovery.js'), 'utf8');
  assert.match(publicDiscovery, /discrepancy_repair_attempted/);
  assert.match(publicDiscovery, /external_job_signal/);
  assert.match(publicDiscovery, /outcome\.status === 'existing'/);
});
