'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { readDigestUnsubscribeToken } = require('../email/digestUnsubscribe');

const router = express.Router();
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(() => {
  res.status(503).type('text').send('Unable to update email preferences right now. Please try again.');
});

function confirmPage(token) {
  return `<!doctype html><meta name="viewport" content="width=device-width"><title>ROOK daily job alerts</title>
<main style="font:18px system-ui;max-width:480px;margin:60px auto;padding:20px">
  <h1>ROOK daily job alerts</h1>
  <p>Confirm to stop daily match emails for this account. You can turn them back on later in Settings.</p>
  <form method="post" action="/api/digest/unsubscribe">
    <input type="hidden" name="token" value="${String(token).replace(/"/g, '&quot;')}">
    <button style="font:inherit;padding:14px">Unsubscribe from daily job alerts</button>
  </form>
</main>`;
}

// GET renders confirmation so link scanners cannot flip preferences.
router.get('/digest/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  const payload = readDigestUnsubscribeToken(token);
  if (!payload) return res.status(400).type('text').send('Invalid or expired unsubscribe link.');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'private, no-store');
  res.type('html').send(confirmPage(token));
});

router.post('/digest/unsubscribe', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const token = String(req.body?.token || req.query.token || '');
  const payload = readDigestUnsubscribeToken(token);
  if (!payload) return res.status(400).type('text').send('Invalid or expired unsubscribe link.');
  if (!db) return res.status(503).type('text').send('Email preferences are not configured yet.');
  const result = await db
    .from('candidate_profiles')
    .update({ digest_enabled: false })
    .eq('id', payload.id);
  if (result.error) throw result.error;
  res.set('Cache-Control', 'private, no-store');
  res.type('text').send('You are unsubscribed from ROOK daily job alerts. You can re-enable them anytime in Settings.');
}));

module.exports = router;
