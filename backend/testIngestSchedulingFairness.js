const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  orderEmployersForIngest,
  employerTimeBudgetMs,
  NEVER_CHECKED_RESERVE_MS,
} = require('./ingestScheduling');

test('never-checked employers are scheduled before oldest remotes and held skips', () => {
  const ordered = orderEmployersForIngest([
    { id: 'held', last_checked_at: '2026-10-01T00:00:00Z', ingestion_hold_reason: 'manual hold' },
    { id: 'old', last_checked_at: '2026-10-06T00:00:00Z' },
    { id: 'never-workday', last_checked_at: null, ats_type: 'workday' },
    { id: 'mid', last_checked_at: '2026-10-07T00:00:00Z' },
    { id: 'never-html', last_checked_at: null, ats_type: 'custom_html' },
  ]).map((row) => row.id);
  assert.deepEqual(ordered, ['never-html', 'never-workday', 'old', 'mid', 'held']);
});

test('backlog pressure shortens expensive ATS budgets so more employers get a first check', () => {
  const workdayNever = { ats_type: 'workday', last_checked_at: null };
  const greenhouseNever = { ats_type: 'greenhouse', last_checked_at: null };
  const workdayRemote = { ats_type: 'workday', last_checked_at: '2026-10-07T00:00:00Z' };
  const remaining = 20 * 60 * 1000;

  const pressured = employerTimeBudgetMs(workdayNever, remaining, {
    neverSyncedRemaining: 40,
    elapsedMs: 60_000,
  });
  const unpressured = employerTimeBudgetMs(workdayRemote, remaining, {
    neverSyncedRemaining: 0,
    elapsedMs: NEVER_CHECKED_RESERVE_MS + 1,
  });
  const cheap = employerTimeBudgetMs(greenhouseNever, remaining, {
    neverSyncedRemaining: 40,
    elapsedMs: 60_000,
  });

  assert.ok(pressured <= 90_000, `expected <=90s under backlog pressure, got ${pressured}`);
  assert.ok(unpressured >= pressured, 'remotes without backlog pressure should not be shorter than pressured never-checked');
  assert.ok(cheap <= 120_000);
  assert.ok(employerTimeBudgetMs({ ingestion_hold_reason: 'x', last_checked_at: '2026-10-01T00:00:00Z' }, remaining) <= 15_000);
});

test('estimated cycle improves when never-checked are prioritized under a 25-minute budget', () => {
  // Model: 46 never-checked @ 90s worst-case expensive + 364 remotes.
  // Old behavior burned 4 minutes on large Workday boards first when ordering
  // failed; new caps keep first-pass never-checked inside ~two scheduled runs.
  const neverChecked = 46;
  const perNeverMs = employerTimeBudgetMs(
    { ats_type: 'workday', last_checked_at: null },
    25 * 60 * 1000,
    { neverSyncedRemaining: neverChecked, elapsedMs: 0 },
  );
  const firstPassMinutes = (neverChecked * perNeverMs) / 60000;
  assert.ok(firstPassMinutes <= 70, `never-checked first pass should fit in ~two 30-min cadences, got ${firstPassMinutes.toFixed(1)} min`);
});
