const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const authz = require('./subscriptionAuthorization');
const { buildSubscriptionConfirmationEmail } = require('./email/subscriptionConfirmation');

function memoryStorage() {
  const objects = new Map();
  const buckets = new Set();
  return {
    storage: {
      async listBuckets() { return { data: [...buckets].map((name) => ({ name })), error: null }; },
      async createBucket(name) { buckets.add(name); return { data: { name }, error: null }; },
      from(bucket) {
        return {
          async upload(objectPath, body, options = {}) {
            const key = `${bucket}:${objectPath}`;
            if (objects.has(key) && !options.upsert) return { data: null, error: { message: 'already exists' } };
            objects.set(key, Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
            return { data: { path: objectPath }, error: null };
          },
          async download(objectPath) {
            const key = `${bucket}:${objectPath}`;
            if (!objects.has(key)) return { data: null, error: { message: 'Object not found' } };
            return { data: { text: async () => objects.get(key) }, error: null };
          },
          async list(prefix) {
            const names = [...objects.keys()]
              .filter((k) => k.startsWith(`${bucket}:${prefix}/`))
              .map((k) => ({ name: k.slice(`${bucket}:${prefix}/`.length) }));
            return { data: names, error: null };
          },
        };
      },
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: { user_id: 'user-1', email: 'a@example.com' }, error: null }),
      };
    },
    _objects: objects,
  };
}

test('consent copy discloses price, recurring renewal, and cancellation for monthly', () => {
  const copy = authz.authorizationCopy('monthly');
  assert.match(copy.consent_text, /\$9\.99/);
  assert.match(copy.consent_text, /\$19\.99 every month/);
  assert.match(copy.consent_text, /Cancel anytime/i);
  assert.match(copy.consent_text, /does not refund the current billing period/i);
  assert.equal(copy.terms_version, authz.TERMS_VERSION);
  assert.equal(copy.checkout_version, authz.CHECKOUT_VERSION);
  assert.equal(copy.recurring_price_cents, 1999);
});

test('one-time passes disclose non-renewal and never claim recurring billing', () => {
  for (const plan of ['two_day', 'three_month']) {
    const copy = authz.authorizationCopy(plan);
    assert.match(copy.consent_text, /does not renew automatically/i);
    assert.equal(copy.recurring_price_cents, null);
    assert.doesNotMatch(copy.consent_text, /every month until I cancel/i);
  }
});

test('recordAuthorization refuses unchecked consent and invents nothing historically', async () => {
  await assert.rejects(
    () => authz.recordAuthorization(memoryStorage(), { userId: 'u1', planId: 'monthly', consented: false, req: {} }),
    /Consent is required/
  );
  await assert.rejects(
    () => authz.recordAuthorization(memoryStorage(), { userId: 'u1', planId: 'nope', consented: true, req: {} }),
    /valid membership/
  );
});

test('recordAuthorization stores server consent text, hashes, and open status', async () => {
  const db = memoryStorage();
  const row = await authz.recordAuthorization(db, {
    userId: 'user-1',
    planId: 'monthly',
    consented: true,
    req: { headers: { 'x-forwarded-for': '8.8.8.8', 'user-agent': 'ROOK-Test/1.0' }, ip: '8.8.8.8' },
    idFactory: () => '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(row.status, 'consented');
  const stored = JSON.parse([...db._objects.values()][0]);
  assert.equal(stored.consent_text, authz.PLAN_CONSENT.monthly.consentText);
  assert.equal(stored.ip_hash, authz.hashIdentifier('8.8.8.8'));
  assert.equal(stored.user_agent_hash, authz.hashIdentifier('ROOK-Test/1.0'));
  assert.notEqual(stored.ip_hash, '8.8.8.8');
});

test('requireOpenAuthorization rejects missing, wrong plan, completed, or stale consent', async () => {
  const db = memoryStorage();
  const id = '11111111-1111-4111-8111-111111111111';
  await authz.recordAuthorization(db, {
    userId: 'user-1', planId: 'monthly', consented: true, req: {}, idFactory: () => id,
  });
  await assert.rejects(
    () => authz.requireOpenAuthorization(db, { userId: 'user-1', authorizationId: id, planId: 'two_day' }),
    /missing or expired/
  );
  const completed = await authz.completeAuthorization(db, {
    authorizationId: id, userId: 'user-1', stripeCustomerId: 'cus_x', purchaseReference: 'sub_x',
  });
  assert.equal(completed.status, 'completed');
  await assert.rejects(
    () => authz.requireOpenAuthorization(db, { userId: 'user-1', authorizationId: id, planId: 'monthly' }),
    /missing or expired/
  );

  const staleDb = memoryStorage();
  const staleId = '22222222-2222-4222-8222-222222222222';
  await authz.recordAuthorization(staleDb, {
    userId: 'user-1', planId: 'monthly', consented: true, req: {},
    idFactory: () => staleId,
    now: new Date(Date.now() - authz.AUTHORIZATION_TTL_MS - 1000),
  });
  await assert.rejects(
    () => authz.requireOpenAuthorization(staleDb, { userId: 'user-1', authorizationId: staleId, planId: 'monthly' }),
    /missing or expired/
  );
});

test('completeAuthorization preserves consent text and only attaches Stripe evidence', async () => {
  const db = memoryStorage();
  const id = '11111111-1111-4111-8111-111111111111';
  await authz.recordAuthorization(db, {
    userId: 'user-1', planId: 'monthly', consented: true, req: {}, idFactory: () => id,
  });
  const row = await authz.completeAuthorization(db, {
    authorizationId: id,
    userId: 'user-1',
    stripeCustomerId: 'cus_test',
    stripeSubscriptionId: 'sub_test',
    purchaseReference: 'sub_test',
  });
  assert.equal(row.status, 'completed');
  assert.equal(row.stripe_subscription_id, 'sub_test');
  assert.equal(row.consent_text, authz.PLAN_CONSENT.monthly.consentText);
  assert.equal(row.terms_version, authz.TERMS_VERSION);
});

test('confirmation email includes pricing, renewal, cancellation, and exact consent text', () => {
  const authorization = {
    plan_id: 'monthly',
    initial_price_cents: 999,
    recurring_price_cents: 1999,
    cancellation_summary: authz.PLAN_CONSENT.monthly.cancellationSummary,
    terms_version: authz.TERMS_VERSION,
    consented_at: '2026-10-23T01:00:00.000Z',
    consent_text: authz.PLAN_CONSENT.monthly.consentText,
  };
  const mail = buildSubscriptionConfirmationEmail(authorization, { publicAppUrl: 'https://rookcareers.com' });
  assert.match(mail.subject, /membership confirmed/i);
  assert.match(mail.html, /\$9\.99/);
  assert.match(mail.html, /\$19\.99/);
  assert.match(mail.html, /every month until you cancel/i);
  assert.match(mail.html, /rook-settings.html\?section=subscription/);
  assert.match(mail.html, /I authorize ROOK Careers to charge \$9\.99 today/);
});

test('current checkout requires unchecked consent before payment APIs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/rook-checkout-current.html'), 'utf8');
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /billingConsent" checked/);
  assert.match(html, /record-authorization/);
  assert.match(html, /authorization_id/);
  assert.match(html, /create-setup-intent/);
  assert.match(html, /purchase-membership/);
  assert.match(html, /Please confirm the billing authorization/);
});

test('stripe purchase paths require authorization_id before charging', () => {
  const stripe = fs.readFileSync(path.join(__dirname, 'routes/stripe.js'), 'utf8');
  assert.match(stripe, /record-authorization/);
  assert.match(stripe, /requireOpenAuthorization/);
  assert.match(stripe, /purchase-membership[\s\S]*authorization_id/);
  assert.match(stripe, /create-setup-intent[\s\S]*requireOpenAuthorization/);
  assert.match(stripe, /create-v8-subscription-from-setup[\s\S]*requireOpenAuthorization/);
  assert.match(stripe, /sendPurchaseConfirmation/);
});

test('admin billing authorization route is owner-gated and storage is private', () => {
  const admin = fs.readFileSync(path.join(__dirname, 'routes/admin.js'), 'utf8');
  const sql = fs.readFileSync(path.join(__dirname, 'db/subscription-authorization.sql'), 'utf8');
  const moduleSource = fs.readFileSync(path.join(__dirname, 'subscriptionAuthorization.js'), 'utf8');
  assert.match(admin, /\/admin\/billing-authorization/);
  assert.match(admin, /requireAdmin/);
  assert.match(admin, /Historical consent is never manufactured/);
  assert.match(sql, /Never invent historical consent/);
  assert.match(moduleSource, /public: false/);
  assert.match(moduleSource, /subscription-authorizations/);
});

test('privacy policy discloses hashed billing authorization technical identifiers', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '../public/rook-privacy.html'), 'utf8');
  assert.match(privacy, /Billing authorization evidence/i);
  assert.match(privacy, /hash of your IP address/i);
  assert.match(privacy, /billing disputes/i);
});
