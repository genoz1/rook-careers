const assert = require('node:assert/strict');
const { test } = require('node:test');
const { countPublicEmployers } = require('./publicEmployerCount');

test('counts distinct employers across the 1,000-row API boundary', async () => {
  const rows = Array.from({ length: 2205 }, (_, i) => ({ id: String(i).padStart(5, '0'), employer_id: `employer-${i % 211}` }));
  const ranges = [];
  const db = { from(table) {
    assert.equal(table, 'jobs');
    const q = {
      select(columns) { assert.equal(columns, 'id, employer_id'); return q; },
      eq() { return q; },
      not() { return q; },
      order(column) { assert.equal(column, 'id'); return q; },
      async range(start, end) { ranges.push([start, end]); return { data: rows.slice(start, end + 1), error: null }; },
    };
    return q;
  } };
  assert.equal(await countPublicEmployers(db), 211);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('fails rather than publishing a partial count when a later page errors', async () => {
  const db = { from() {
    const q = {
      select() { return q; }, eq() { return q; }, not() { return q; }, order() { return q; },
      async range(start) { return start === 0 ? { data: Array(1000).fill({ employer_id: 'one' }), error: null } : { data: null, error: new Error('page failed') }; },
    };
    return q;
  } };
  await assert.rejects(countPublicEmployers(db), /page failed/);
});
