const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverEmployer } = require('./ingestionRecovery');
const { nextIncident, checkIngestionHealth } = require('./ingestionHealth');
const entry = { employer_id: 'employer', name: 'Example', status: 'failed', error: 'Source 503' };
const now = '2026-09-23T16:00:00Z';
test('source read failure retries inside the original deadline and records recovery', async () => {
  const budgets = [];
  const result = await recoverEmployer({}, 20000, async (_, budget) => {
    budgets.push(budget);
    return budgets.length === 1 ? { status: 'failed', failure_stage: 'source', counts_complete: true, metrics: { source_failures: 1 } } :
      { status: 'completed', counts_complete: true, metrics: { inserted: 2, updated: 4 } };
  });
  assert.equal(result.recovered, true); assert.equal(result.attempts.length, 2);
  assert.equal(result.metrics.inserted, 2); assert.equal(result.metrics.source_failures, 1);
  assert(budgets[1] < budgets[0]);
});
test('timeout, partial writes, partial snapshots and exhausted budget are never blindly retried', async () => {
  for (const first of [
    { status: 'timeout', counts_complete: false },
    { status: 'partial' },
    { status: 'failed', failure_stage: 'source', metrics: { inserted: 1 } },
    { status: 'failed', failure_stage: 'source', metrics: { closed: 1 } },
    { status: 'failed', failure_stage: 'database' },
  ]) {
    let calls = 0;
    await recoverEmployer({}, 20000, async () => { calls++; return first; });
    assert.equal(calls, 1);
  }
  const result = await recoverEmployer({}, 100, async () => ({ status: 'failed', failure_stage: 'source' }));
  assert.equal(result.attempts.length, 1);
});
test('incidents require distinct failed runs; recovery resets and later recurrence opens a new incident', () => {
  const first = nextIncident(null, entry, 'run1', now);
  assert.equal(first.consecutive_failures, 1);
  assert.deepEqual(nextIncident(first, entry, 'run1', now), first);
  const second = nextIncident(first, entry, 'run2', now);
  assert.equal(second.consecutive_failures, 2);
  const fixed = nextIncident(second, { ...entry, status: 'completed' }, 'run3', now);
  assert(fixed.resolved_at); assert.equal(fixed.consecutive_failures, 0);
  const recurrence = nextIncident(fixed, entry, 'run4', now);
  assert.notEqual(recurrence.incident_id, first.incident_id);
  assert.equal(recurrence.consecutive_failures, 1);
  assert.equal(nextIncident(first, { ...entry, status: 'not_reached' }, 'run5', now), null);
});
function database() {
  const rows = new Map();
  return { rows, from: () => ({
    select: async () => ({ data: [...rows.values()] }),
    upsert: async row => { rows.set(row.employer_id, { ...row }); return {}; },
    update: values => ({ eq: id => ({ eq: async (_, incidentId) => {
      for (const row of rows.values()) if (row.incident_id === incidentId) Object.assign(row, values);
      return {};
    } }) }),
  }) };
}
test('only unresolved failures email; repeat observations are silent and HTML is escaped', async () => {
  const db = database(), emails = [];
  const options = { to: 'operator@example.test', now, sendEmail: async email => { emails.push(email); } };
  const run = n => ({ run_id: `run${n}`, summary: { employers: [{ ...entry, name: '<Example>' }] } });
  await checkIngestionHealth(db, run(1), options); assert.equal(emails.length, 0);
  await checkIngestionHealth(db, run(2), options); assert.equal(emails.length, 1);
  assert(emails[0].subject.startsWith('URGENT — ROOK'));
  assert(emails[0].html.includes('&lt;Example&gt;'));
  await checkIngestionHealth(db, run(3), options); assert.equal(emails.length, 1);
  await checkIngestionHealth(db, { run_id: 'fixed', summary: { employers: [{ ...entry, status: 'completed' }] } }, options);
  assert(db.rows.get('employer').resolved_at);
});
test('failed email is retried with the same incident delivery key', async () => {
  const db = database(), keys = [];
  const run = n => ({ run_id: `run${n}`, summary: { employers: [entry] } });
  const options = { to: 'operator@example.test', now, sendEmail: async email => { keys.push(email.idempotencyKey); if (keys.length === 1) throw Error('mail unavailable'); } };
  await checkIngestionHealth(db, run(1), options);
  await assert.rejects(checkIngestionHealth(db, run(2), options), /mail unavailable/);
  assert.equal(db.rows.get('employer').emailed_at, null);
  await checkIngestionHealth(db, run(2), options);
  assert.equal(keys[0], keys[1]); assert.equal(keys.length, 2);
});
