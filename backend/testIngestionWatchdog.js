const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runHealth, regressionCheck, systemIncident } = require('./ingestionWatchdog');
const now = Date.parse('2026-09-23T18:00:00Z');
const run = (minutes, status = 'completed', ended = true) => ({ started_at: new Date(now - minutes * 60000).toISOString(),
  ended_at: ended ? new Date(now - (minutes - 1) * 60000).toISOString() : null, status, summary: {} });
test('watchdog distinguishes normal, stalled, missing and failed scheduled runs', () => {
  assert.equal(runHealth([run(30)], now), null);
  assert.equal(runHealth([run(20, 'running', false)], now), null);
  assert.match(runHealth([run(45, 'running', false)], now), /maximum duration/);
  assert.equal(runHealth([run(1000)], now), null);
  assert.match(runHealth([run(1300)], now), /stopped reporting/);
  assert.match(runHealth([run(20, 'failed')], now), /failed/);
  assert.match(runHealth([], now), /No scheduled/);
  assert.match(runHealth([{ ...run(10), summary: { manual: true } }, run(1300)], now), /stopped reporting/);
});
test('deployed deterministic safety checks pass without production writes or provider calls', async () => {
  assert.equal(await regressionCheck(), null);
});
test('watchdog emails once after persistent failure and rearms after recovery', async () => {
  let row = null; const sent = [];
  const db = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }),
    upsert: async value => { row = { ...value }; return {}; },
    update: value => ({ eq: () => ({ eq: async () => { Object.assign(row, value); return {}; } }) }),
  }) };
  const options = { to: 'operator@example.test', sendEmail: async email => sent.push(email), now: new Date(now).toISOString(),
    diagnose: async () => ({ action: 'escalate', diagnosis: 'Requires operator review' }) };
  await systemIncident(db, 'The latest ingestion run failed.', options); assert.equal(sent.length, 0);
  await systemIncident(db, 'The latest ingestion run failed.', options); assert.equal(sent.length, 1);
  await systemIncident(db, 'The latest ingestion run failed.', options); assert.equal(sent.length, 1);
  const original = row.incident_id;
  await systemIncident(db, null, options); assert.equal(row.failure_count, 0);
  await systemIncident(db, 'The latest ingestion run failed.', options); assert.notEqual(row.incident_id, original);
  await systemIncident(db, 'The latest ingestion run failed.', options); assert.equal(sent.length, 2);
  assert(sent.every(email => email.subject.startsWith('URGENT — ROOK')));
});
