'use strict';

const crypto = require('crypto');

/**
 * Prefer a dedicated secret when configured. Otherwise use app-level secrets
 * shared by both rook-daily-digest (sender) and rook-careers (unsubscribe route).
 * Do not prefer service-only secrets like ACQ_SIGNING_SECRET first — that would
 * sign with one key in the digest job and verify with another on the web app.
 */
function digestUnsubscribeSecret(env = process.env) {
  return (
    env.DIGEST_UNSUBSCRIBE_SECRET
    || env.SOCIAL_SPACING_HMAC_SECRET
    || env.SUPABASE_SERVICE_ROLE_KEY
    || env.ACQ_SIGNING_SECRET
    || ''
  );
}

function signDigestUnsubscribeToken(candidateId, {
  secret = digestUnsubscribeSecret(),
  now = Date.now(),
  ttlMs = 365 * 24 * 60 * 60 * 1000,
} = {}) {
  const id = String(candidateId || '').trim();
  if (!id) throw new Error('digest unsubscribe token requires a candidate id');
  if (!secret) throw new Error('digest unsubscribe signing secret is not configured');
  const body = Buffer.from(JSON.stringify({
    purpose: 'digest_unsubscribe',
    id,
    exp: now + ttlMs,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readDigestUnsubscribeToken(token, {
  secret = digestUnsubscribeSecret(),
  now = Date.now(),
} = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 2048) return null;
  if (!secret) return null;
  const [body, sig, ...extra] = token.split('.');
  if (extra.length || !body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.purpose !== 'digest_unsubscribe') return null;
    if (!payload.id || typeof payload.id !== 'string') return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function digestUnsubscribeUrl(appBaseUrl, candidateId, options = {}) {
  const base = String(appBaseUrl || '').replace(/\/$/, '');
  const token = signDigestUnsubscribeToken(candidateId, options);
  return `${base}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
}

module.exports = {
  digestUnsubscribeSecret,
  digestUnsubscribeUrl,
  readDigestUnsubscribeToken,
  signDigestUnsubscribeToken,
};
