// Server-side subscription authorization evidence for ROOK Careers.
// Durable store: private Supabase Storage bucket (service-role only).
// Consent text is authored here (not trusted from the client). Customers cannot
// read or alter these objects. Historical consent is never manufactured.
// SQL migration backend/db/subscription-authorization.sql remains available for
// an optional relational cutover; this module does not invent past rows.

const crypto = require('crypto');
const { publicIp } = require('./ipLocation');

const TERMS_VERSION = '2026-09-01';
const CHECKOUT_VERSION = 'v8-current';
const AUTHORIZATION_TTL_MS = 2 * 60 * 60 * 1000;
const BUCKET = 'subscription-authorizations';

const PLAN_CONSENT = Object.freeze({
  two_day: Object.freeze({
    planId: 'two_day',
    kind: 'one_time',
    initialPriceCents: 599,
    recurringPriceCents: null,
    billingInterval: null,
    cancellationSummary: 'One-time 48-hour pass. Does not renew automatically.',
    consentText:
      'I authorize ROOK Careers to charge a one-time payment of $5.99 for 48 hours of membership access. ' +
      'This pass does not renew automatically and will not create recurring charges. ' +
      'I agree to the ROOK Terms of Service (version 2026-09-01) and Privacy Policy.',
  }),
  monthly: Object.freeze({
    planId: 'monthly',
    kind: 'subscription',
    initialPriceCents: 999,
    recurringPriceCents: 1999,
    billingInterval: 'month',
    cancellationSummary:
      'Cancel anytime in Account Settings → Billing. Cancellation stops future charges and does not refund the current billing period.',
    consentText:
      'I authorize ROOK Careers to charge $9.99 today for my first month of membership, then $19.99 every month until I cancel. ' +
      'Billing renews automatically each month. I can cancel anytime in Account Settings (Billing portal); ' +
      'cancellation stops future charges and does not refund the current billing period. ' +
      'I agree to the ROOK Terms of Service (version 2026-09-01) and Privacy Policy.',
  }),
  three_month: Object.freeze({
    planId: 'three_month',
    kind: 'one_time',
    initialPriceCents: 3999,
    recurringPriceCents: null,
    billingInterval: null,
    cancellationSummary: 'One-time 3-month pass. Does not renew automatically.',
    consentText:
      'I authorize ROOK Careers to charge a one-time payment of $39.99 for 3 months of membership access ($13.33/month equivalent). ' +
      'This pass does not renew automatically and will not create recurring charges. ' +
      'I agree to the ROOK Terms of Service (version 2026-09-01) and Privacy Policy.',
  }),
});

function hashIdentifier(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return publicIp(forwarded) || publicIp(req?.ip) || null;
}

function planOffer(planId) {
  return PLAN_CONSENT[planId] || null;
}

function authorizationCopy(planId) {
  const offer = planOffer(planId);
  if (!offer) return null;
  return {
    plan_id: offer.planId,
    kind: offer.kind,
    consent_text: offer.consentText,
    terms_version: TERMS_VERSION,
    checkout_version: CHECKOUT_VERSION,
    initial_price_cents: offer.initialPriceCents,
    recurring_price_cents: offer.recurringPriceCents,
    billing_interval: offer.billingInterval,
    cancellation_summary: offer.cancellationSummary,
  };
}

function isFreshConsent(row, now = Date.now()) {
  if (!row || row.status !== 'consented') return false;
  const at = Date.parse(row.consented_at);
  return Number.isFinite(at) && now - at <= AUTHORIZATION_TTL_MS;
}

function objectPath(userId, authorizationId) {
  return `${userId}/${authorizationId}.json`;
}

async function ensureBucket(db) {
  const listed = await db.storage.listBuckets();
  if (listed.error) throw listed.error;
  if ((listed.data || []).some((b) => b.name === BUCKET)) return;
  const created = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 100 * 1024 });
  if (created.error && !/already exists/i.test(created.error.message || '')) throw created.error;
}

async function writeAuthorization(db, row, { upsert }) {
  await ensureBucket(db);
  const body = Buffer.from(JSON.stringify(row, null, 2));
  const result = await db.storage.from(BUCKET).upload(objectPath(row.user_id, row.id), body, {
    contentType: 'application/json',
    upsert: Boolean(upsert),
  });
  if (result.error) throw result.error;
  return row;
}

async function readAuthorization(db, userId, authorizationId) {
  await ensureBucket(db);
  const result = await db.storage.from(BUCKET).download(objectPath(userId, authorizationId));
  if (result.error) {
    if (/not found|Object not found/i.test(result.error.message || '')) return null;
    throw result.error;
  }
  const text = await result.data.text();
  return JSON.parse(text);
}

async function listUserAuthorizations(db, userId) {
  await ensureBucket(db);
  const listed = await db.storage.from(BUCKET).list(userId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
  if (listed.error) throw listed.error;
  const rows = [];
  for (const file of listed.data || []) {
    if (!file.name.endsWith('.json')) continue;
    const id = file.name.replace(/\.json$/, '');
    const row = await readAuthorization(db, userId, id);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => String(b.consented_at || '').localeCompare(String(a.consented_at || '')));
  return rows;
}

async function recordAuthorization(db, {
  userId,
  planId,
  consented,
  req,
  checkoutVersion = CHECKOUT_VERSION,
  now = new Date(),
  idFactory = () => crypto.randomUUID(),
}) {
  if (consented !== true) {
    const err = new Error('Consent is required before payment.');
    err.status = 400;
    throw err;
  }
  const offer = planOffer(planId);
  if (!offer) {
    const err = new Error('Choose a valid membership option.');
    err.status = 400;
    throw err;
  }
  if (!userId) {
    const err = new Error('Authentication required.');
    err.status = 401;
    throw err;
  }

  const row = {
    id: idFactory(),
    user_id: userId,
    plan_id: offer.planId,
    kind: offer.kind,
    consent_text: offer.consentText,
    terms_version: TERMS_VERSION,
    checkout_version: checkoutVersion,
    initial_price_cents: offer.initialPriceCents,
    recurring_price_cents: offer.recurringPriceCents,
    billing_interval: offer.billingInterval,
    cancellation_summary: offer.cancellationSummary,
    consented_at: now.toISOString(),
    status: 'consented',
    ip_hash: hashIdentifier(clientIp(req)),
    user_agent_hash: hashIdentifier(req?.headers?.['user-agent']),
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_payment_intent_id: null,
    purchase_reference: null,
    completed_at: null,
    confirmation_email_sent_at: null,
    created_at: now.toISOString(),
  };

  await writeAuthorization(db, row, { upsert: false });
  return {
    id: row.id,
    plan_id: row.plan_id,
    consent_text: row.consent_text,
    terms_version: row.terms_version,
    checkout_version: row.checkout_version,
    consented_at: row.consented_at,
    status: row.status,
  };
}

async function requireOpenAuthorization(db, { userId, authorizationId, planId }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(authorizationId || ''))) {
    const err = new Error('Billing authorization is required before payment.');
    err.status = 400;
    throw err;
  }
  const data = await readAuthorization(db, userId, authorizationId);
  if (!data || data.user_id !== userId || !isFreshConsent(data) || data.plan_id !== planId) {
    const err = new Error('Billing authorization is missing or expired. Please check the consent box and try again.');
    err.status = 400;
    throw err;
  }
  return data;
}

async function completeAuthorization(db, {
  authorizationId,
  userId,
  stripeCustomerId,
  stripeSubscriptionId = null,
  stripePaymentIntentId = null,
  purchaseReference = null,
  now = new Date(),
}) {
  const existing = await readAuthorization(db, userId, authorizationId);
  if (!existing || existing.user_id !== userId || existing.status !== 'consented') {
    const err = new Error('Billing authorization could not be finalized.');
    err.status = 409;
    throw err;
  }
  // Preserve original consent fields; only attach purchase evidence.
  const next = {
    ...existing,
    status: 'completed',
    stripe_customer_id: stripeCustomerId || null,
    stripe_subscription_id: stripeSubscriptionId || null,
    stripe_payment_intent_id: stripePaymentIntentId || null,
    purchase_reference: purchaseReference || null,
    completed_at: now.toISOString(),
  };
  await writeAuthorization(db, next, { upsert: true });
  return next;
}

async function markConfirmationEmailSent(db, authorizationId, userId, sentAt = new Date().toISOString()) {
  const existing = await readAuthorization(db, userId, authorizationId);
  if (!existing || existing.confirmation_email_sent_at) return existing;
  const next = { ...existing, confirmation_email_sent_at: sentAt };
  await writeAuthorization(db, next, { upsert: true });
  return next;
}

async function getAuthorizationsForAdmin(db, { email, userId }) {
  let uid = userId || null;
  let profile = null;
  if (!uid && email) {
    const { data, error } = await db
      .from('candidate_profiles')
      .select('user_id, email, stripe_customer_id, subscription_status, subscription_started_at, subscription_cancel_at')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    if (!data?.user_id) return { profile: null, authorizations: [] };
    profile = data;
    uid = data.user_id;
  } else if (uid) {
    const { data, error } = await db
      .from('candidate_profiles')
      .select('user_id, email, stripe_customer_id, subscription_status, subscription_started_at, subscription_cancel_at')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw error;
    profile = data || { user_id: uid };
  }
  const authorizations = await listUserAuthorizations(db, uid);
  return { profile, authorizations };
}

module.exports = {
  TERMS_VERSION,
  CHECKOUT_VERSION,
  AUTHORIZATION_TTL_MS,
  BUCKET,
  PLAN_CONSENT,
  planOffer,
  authorizationCopy,
  hashIdentifier,
  clientIp,
  isFreshConsent,
  objectPath,
  recordAuthorization,
  requireOpenAuthorization,
  completeAuthorization,
  markConfirmationEmailSent,
  getAuthorizationsForAdmin,
};
