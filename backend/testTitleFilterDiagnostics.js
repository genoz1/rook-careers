const assert = require('node:assert/strict');
const { test } = require('node:test');
const { titleLooksRelevant } = require('./relevanceFilter');
const {
  RETENTION_DAYS,
  withTitleFilterDiagnostics,
  getTitleFilterRejections,
  titleLooksRelevantWithDiagnostics,
  persistTitleFilterRejections,
  pruneTitleFilterRejections,
} = require('./titleFilterDiagnostics');
const { workdayTitleLooksRelevant } = require('./adapters/workday');

test('a rejected title captures a minimal diagnostic record and persistence stores it', async () => {
  await withTitleFilterDiagnostics({ id: 'employer-1', company_name: 'Example Diagnostics', ats_type: 'workday' }, async () => {
    const posting = { jobReqId: 'REQ-9', location: 'Tampa, FL', title: 'Specialty Development Executive', description: 'must not be stored' };
    assert.equal(titleLooksRelevantWithDiagnostics(posting.title, posting), false);
    const [record] = getTitleFilterRejections();
    assert.equal(record.company_name, 'Example Diagnostics');
    assert.equal(record.source_adapter, 'workday');
    assert.equal(record.source_job_id, 'REQ-9');
    assert.equal(record.location, 'Tampa, FL');
    assert.equal(record.title, posting.title);
    assert.match(record.rejection_reason, /titleLooksRelevant returned false/);
    assert.ok(record.rejected_at);
    assert.equal('description' in record, false);

    const saved = [];
    const db = { from(table) { assert.equal(table, 'ingestion_title_filter_rejections'); return {
      upsert: async (rows, options) => { assert.deepEqual(options, { onConflict: 'diagnostic_key' }); saved.push(...rows); return { error: null }; },
    }; } };
    assert.equal(await persistTitleFilterRejections(db, [record]), 1);
    assert.deepEqual(saved, [record]);
  });
});

test('accepted titles produce no rejection record', async () => {
  await withTitleFilterDiagnostics({ id: 'employer-1', company_name: 'Example Diagnostics', ats_type: 'workday' }, async () => {
    assert.equal(titleLooksRelevantWithDiagnostics('Medical Device Territory Sales Manager', { id: 'REQ-10' }), true);
    assert.deepEqual(getTitleFilterRejections(), []);
  });
});

test('diagnostic wrapper preserves titleLooksRelevant decisions exactly', async () => {
  const titles = [
    'Medical Device Territory Sales Manager',
    'Specialty Development Executive',
    'Clinical Procedure Specialist',
    'Accounts Payable Manager',
  ];
  await withTitleFilterDiagnostics({ id: 'employer-1', company_name: 'Example', ats_type: 'workday' }, async () => {
    for (const title of titles) {
      assert.equal(titleLooksRelevantWithDiagnostics(title), titleLooksRelevant(title), title);
    }
  });
});

test('Labcorp Workday commercial override remains accepted without a generic rejection record', async () => {
  const identifier = 'labcorp|wd1|External';
  await withTitleFilterDiagnostics({ id: 'labcorp-id', company_name: 'Labcorp', ats_type: 'workday' }, async () => {
    assert.equal(titleLooksRelevant('Specialty Development Executive - Southeast Florida'), false);
    assert.equal(workdayTitleLooksRelevant('Specialty Development Executive - Southeast Florida', identifier, { jobReqId: '2628302' }), true);
    assert.deepEqual(getTitleFilterRejections(), []);
  });
});

test('diagnostic history is retained for 30 days', () => {
  assert.equal(RETENTION_DAYS, 30);
});

test('retention pruning removes only records older than 30 days', async () => {
  let table, column, cutoff;
  const db = { from(name) { table = name; return { delete() { return { lt: async (key, value) => { column = key; cutoff = value; return { error: null }; } }; } }; } };
  const now = new Date('2026-09-26T12:00:00.000Z');
  await pruneTitleFilterRejections(db, { now });
  assert.equal(table, 'ingestion_title_filter_rejections');
  assert.equal(column, 'rejected_at');
  assert.equal(cutoff, '2026-08-27T12:00:00.000Z');
});
