const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDigestEmail } = require('./email/resolveDigestEmail');

test('recovers verified account email for an earlier V8 profile with no email', async () => {
  const db = { auth: { admin: { getUserById: async id => {
    assert.equal(id, 'member-1');
    return { data: { user: { email: 'member@example.test', email_confirmed_at: '2026-09-27' } } };
  } } } };
  assert.equal((await resolveDigestEmail(db, { id: 'profile-1', user_id: 'member-1', email: null })).email, 'member@example.test');
  assert.equal((await resolveDigestEmail(db, { email: 'old@example.test' })).email, 'old@example.test');
});

test('does not send to an unverified account email', async () => {
  const db = { auth: { admin: { getUserById: async () => ({ data: { user: { email: 'unverified@example.test' } } }) } } };
  assert.equal((await resolveDigestEmail(db, { user_id: 'member-2' })).email, undefined);
});
