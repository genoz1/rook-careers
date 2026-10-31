'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  digestUnsubscribeUrl,
  readDigestUnsubscribeToken,
  signDigestUnsubscribeToken,
} = require('./email/digestUnsubscribe');

process.env.DIGEST_UNSUBSCRIBE_SECRET = process.env.DIGEST_UNSUBSCRIBE_SECRET || 'test-digest-unsubscribe-secret';

test('digest unsubscribe tokens sign, verify, and expire', () => {
  const now = 1_700_000_000_000;
  const token = signDigestUnsubscribeToken('candidate-1', { now, ttlMs: 60_000 });
  const ok = readDigestUnsubscribeToken(token, { now: now + 1_000 });
  assert.equal(ok.id, 'candidate-1');
  assert.equal(ok.purpose, 'digest_unsubscribe');
  assert.equal(readDigestUnsubscribeToken(token, { now: now + 120_000 }), null);
  assert.equal(readDigestUnsubscribeToken(token + 'x', { now }), null);
  assert.equal(readDigestUnsubscribeToken('not-a-token', { now }), null);
});

test('digest unsubscribe URL points at the member route', () => {
  const url = digestUnsubscribeUrl('https://rookcareers.com', '646925e1-b7ef-470c-b643-58fd9d006200');
  assert.match(url, /^https:\/\/rookcareers\.com\/api\/digest\/unsubscribe\?token=/);
  const token = decodeURIComponent(url.split('token=')[1]);
  assert.equal(readDigestUnsubscribeToken(token).id, '646925e1-b7ef-470c-b643-58fd9d006200');
});

test('digest unsubscribe route confirms on GET and disables digest on POST', async () => {
  const updates = [];
  const token = signDigestUnsubscribeToken('candidate-42');
  require.cache[require.resolve('./routes/digest')] = undefined;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-key';

  const supabasePath = require.resolve('@supabase/supabase-js');
  const previous = require.cache[supabasePath];
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: {
      createClient: () => ({
        from(table) {
          return {
            update(value) {
              this.value = value;
              return this;
            },
            eq(column, id) {
              updates.push({ table, value: this.value, column, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      }),
    },
  };

  try {
    const app = express();
    app.use('/api', require('./routes/digest'));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;

    let response = await fetch(`${base}/digest/unsubscribe?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /method="post"/i);
    assert.equal(updates.length, 0);

    response = await fetch(`${base}/digest/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /unsubscribed from ROOK daily job alerts/i);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].table, 'candidate_profiles');
    assert.equal(updates[0].id, 'candidate-42');
    assert.equal(updates[0].value.digest_enabled, false);

    assert.equal((await fetch(`${base}/digest/unsubscribe?token=bad`)).status, 400);
    await new Promise((resolve) => server.close(resolve));
  } finally {
    if (previous) require.cache[supabasePath] = previous;
    else delete require.cache[supabasePath];
    delete require.cache[require.resolve('./routes/digest')];
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
