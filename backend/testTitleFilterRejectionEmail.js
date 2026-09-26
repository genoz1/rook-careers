const test = require('node:test');
const assert = require('node:assert/strict');
const { easternParts, sendDailyTitleFilterRejections } = require('./titleFilterRejectionEmail');

function dbWith(rows) {
  return { from(table) {
    assert.equal(table, 'ingestion_title_filter_rejections');
    const query = { select() { return query; }, gte() { return query; }, order() { return query; }, limit: async () => ({ data: rows, error: null }) };
    return query;
  } };
}

test('recognizes 8 AM Eastern across daylight saving time', () => {
  assert.deepEqual(easternParts(new Date('2026-09-26T12:05:00Z')), { date: '2026-09-26', hour: 8 });
  assert.deepEqual(easternParts(new Date('2026-12-26T13:05:00Z')), { date: '2026-12-26', hour: 8 });
});

test('sends one daily email containing recent rejection details', async () => {
  const emails = [];
  const row = { company_name: 'Example & Co', title: 'Specialty Executive', location: 'Tampa, FL', source_adapter: 'workday', source_job_id: '123' };
  const result = await sendDailyTitleFilterRejections(dbWith([row]), {
    now: new Date('2026-09-26T12:05:00Z'), to: 'operator@example.test', sendEmail: async email => emails.push(email),
  });
  assert.equal(result.sent, true);
  assert.equal(result.date, '2026-09-26');
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /1 title-filter rejection/);
  assert.match(emails[0].html, /Example &amp; Co/);
  assert.match(emails[0].html, /Specialty Executive/);
  assert.equal(emails[0].idempotencyKey, 'title-filter-rejections-2026-09-26');
});

test('does not send outside 8 AM, twice in one day, or with no rows', async () => {
  let sends = 0;
  const sendEmail = async () => { sends++; };
  assert.equal((await sendDailyTitleFilterRejections(dbWith([{}]), { now: new Date('2026-09-26T11:59:00Z'), sendEmail })).sent, false);
  assert.equal((await sendDailyTitleFilterRejections(dbWith([{}]), { now: new Date('2026-09-26T12:05:00Z'), lastSentDate: '2026-09-26', sendEmail })).sent, false);
  const empty = await sendDailyTitleFilterRejections(dbWith([]), { now: new Date('2026-09-26T12:05:00Z'), sendEmail });
  assert.equal(empty.sent, false);
  assert.equal(empty.date, '2026-09-26');
  assert.equal(sends, 0);
});
