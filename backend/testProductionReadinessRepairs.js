const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { safeLocationLabel } = require('./maskedPresentation');
const { scoreJob } = require('./matching');
const { scoreLiveJob, liveScoreOptions } = require('./liveScoring');
const { prepareJob } = require('./v7Location');
const { MEMBERSHIP_PLANS, accessEnd, handleStripeWebhookEvent } = require('./routes/stripe');
const { hasFullAccess } = require('./matching');
const { summarizeIngestionHealth } = require('./routes/admin');

const root = path.join(__dirname, '..');

test('robots.txt no longer invites crawlers onto /api/jobs', () => {
  const robots = fs.readFileSync(path.join(root, 'public/robots.txt'), 'utf8');
  assert.match(robots, /Disallow:\s*\/api\//);
  assert.doesNotMatch(robots, /Allow:\s*\/api\/jobs/);
});

test('anonymous unscoped /api/jobs path caps the job pool', () => {
  const src = fs.readFileSync(path.join(root, 'backend/routes/jobs.js'), 'utf8');
  assert.match(src, /maxAccepted:\s*poolCap/);
  assert.match(src, /poolCap = Math\.min/);
});

test('sitemap uses an in-memory cache and avoids SEO inventory rebuild', () => {
  const src = fs.readFileSync(path.join(root, 'backend/routes/publicPages.js'), 'utf8');
  assert.match(src, /sitemapCache/);
  assert.match(src, /SITEMAP_TTL_MS/);
  assert.doesNotMatch(src, /loadSeoInventory\(\)/);
  assert.match(src, /Object\.keys\(CATEGORIES\)/);
});

test('SEO inventory cache TTL is at least five minutes', () => {
  const src = fs.readFileSync(path.join(root, 'backend/seoInventory.js'), 'utf8');
  assert.match(src, /ttl=10\s*\*\s*60\s*\*\s*1000|ttl=\d{5,}/);
  // Heavy description_text pages timed out under parallel PostgREST reads.
  assert.doesNotMatch(src, /SEO_SELECT='[^']*description_text/);
});

test('settings and auth sidebars never say Free Trial', () => {
  const settings = fs.readFileSync(path.join(root, 'public/rook-settings.html'), 'utf8');
  const authV8 = fs.readFileSync(path.join(root, 'public/rook-auth-v8.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'public/rook-auth.js'), 'utf8');
  assert.doesNotMatch(settings, /Free Trial/);
  assert.doesNotMatch(authV8, /'Free Trial'/);
  assert.doesNotMatch(auth, /'Free Trial'/);
  assert.match(settings, /Membership — Active/);
  assert.match(authV8, /Monthly membership/);
});

test('safeLocationLabel restores city/state when ZIP lookup misses and parses combined city fields', () => {
  assert.equal(safeLocationLabel({ city: 'Orlando', state: 'FL' }), 'Orlando, FL');
  assert.equal(safeLocationLabel({ city: 'Tampa, FL', state: '' }), 'Tampa, FL');
  assert.equal(safeLocationLabel({ city: '', state: 'FL', location_raw: 'Miami, FL, United States' }), 'Miami, FL');
  assert.equal(safeLocationLabel({ city: 'Someville', state: 'FL' }), 'Someville, FL');
  assert.equal(safeLocationLabel({ remote_status: 'remote', state: 'TX' }), 'Remote – TX');
  assert.equal(safeLocationLabel({
    location_evidence: { scope: { kind: 'territory', states: ['FL', 'GA'] } },
  }), 'Territory – FL, GA');
  // Do not invent from employer-looking free text alone.
  assert.equal(safeLocationLabel({ location_raw: 'Confidential — Acme Corp HQ' }), null);
});

test('no-resume preference scores spread across distance, age, and industry', () => {
  const profile = {
    home_lat: 25.76, home_lng: -80.19, home_state: 'Florida',
    desired_industries: ['Medical Device'],
    territory_size_preferences: ['local'],
    total_sales_years: 5,
  };
  const evidence = (title, loc, lat, lng, state) => ({
    version: 4, status: 'validated', source_location: loc, source_title: title,
    locations: [{ lat, lng, state }],
  });
  const nearFresh = {
    id: 'a', title_original: 'Medical Device Territory Manager - Miami, FL',
    location_raw: 'Miami, Florida, United States',
    job_lat: 25.78, job_lng: -80.20, city: 'Miami', state: 'FL',
    date_posted: new Date().toISOString(),
    ai_analysis: { product_categories: ['Medical Device'], required_industries: ['Medical Device'] },
    location_evidence: evidence('Medical Device Territory Manager - Miami, FL', 'Miami, Florida, United States', 25.78, -80.20, 'FL'),
  };
  const farOld = {
    id: 'b', title_original: 'Pharmaceutical Sales Representative - Seattle, WA',
    location_raw: 'Seattle, Washington, United States',
    job_lat: 47.6, job_lng: -122.3, city: 'Seattle', state: 'WA',
    date_posted: new Date(Date.now() - 60 * 86400000).toISOString(),
    ai_analysis: { product_categories: ['Pharmaceutical'], required_industries: ['Pharmaceutical'] },
    location_evidence: evidence('Pharmaceutical Sales Representative - Seattle, WA', 'Seattle, Washington, United States', 47.6, -122.3, 'WA'),
  };
  const nearPrepared = prepareJob(nearFresh, profile);
  const farPrepared = prepareJob(farOld, profile);
  assert.ok(nearPrepared, 'near job should prepare');
  // Far WA local may be null under FL home eligibility — score via live helper on raw then.
  const near = scoreLiveJob(nearPrepared, profile, nearPrepared);
  const far = farPrepared
    ? scoreLiveJob(farPrepared, profile, farPrepared)
    : scoreJob(farOld, profile, { smoothLocalDistance: true });
  assert.ok(near.overall_score > (far.overall_score ?? 0), `${near.overall_score} vs ${far.overall_score}`);
  assert.ok(near.overall_score - (far.overall_score ?? 0) >= 8, 'spread should be meaningful');
});

test('live scoring options stay attached on scoreLiveJob', () => {
  const prepared = prepareJob({
    id: 'x', title_original: 'Territory Manager', job_lat: 28.5, job_lng: -81.4,
    city: 'Orlando', state: 'FL', location_raw: 'Orlando, FL',
  }, { home_lat: 28.5, home_lng: -81.4, home_state: 'FL' });
  const opts = liveScoreOptions(prepared);
  assert.equal(opts.smoothLocalDistance, true);
  assert.equal(opts.canonicalVeterinaryEvidence, true);
  assert.ok(opts.geography);
});

test('detail/onboarding/precompute call sites use scoreLiveJob', () => {
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const jobs = stripComments(fs.readFileSync(path.join(root, 'backend/routes/jobs.js'), 'utf8'));
  const pre = stripComments(fs.readFileSync(path.join(root, 'backend/scoring/precompute.js'), 'utf8'));
  assert.ok((jobs.match(/scoreLiveJob\(/g) || []).length >= 5);
  assert.equal((jobs.match(/(?<![a-zA-Z])scoreJob\(/g) || []).length, 0);
  assert.match(pre, /scoreLiveJob\(/);
  assert.equal((pre.match(/(?<![a-zA-Z])scoreJob\(/g) || []).length, 0);
  assert.match(pre, /liveScoring/);
});

test('stripe webhook fixtures unlock and expire all three membership plans', async () => {
  const updates = [];
  const candidateBuilder = (mode) => {
    const builder = {
      eq() { return builder; }, is() { return builder; }, lt() { return builder; },
      select() { return builder; },
      maybeSingle() {
        return Promise.resolve({
          data: { name: 'Buyer', email: 'buyer@example.com', utm_source: 'audit' },
          error: null,
        });
      },
      then(resolve, reject) {
        return Promise.resolve({ data: mode === 'update' ? [{ id: 'profile' }] : null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
  const db = {
    from(table) {
      if (table === 'candidate_profiles') {
        return {
          update(payload) { updates.push(payload); return candidateBuilder('update'); },
          select() { return candidateBuilder('select'); },
        };
      }
      if (table === 'ad_conversion_events') {
        return { insert() { return Promise.resolve({ error: null }); } };
      }
      throw Error(`unexpected table ${table}`);
    },
  };

  const twoDay = {
    id: 'evt_two_day', type: 'payment_intent.succeeded',
    created: Date.parse('2026-03-01T12:00:00Z') / 1000,
    data: { object: { amount_received: 599, currency: 'usd', customer: 'cus_a',
      metadata: { membership_plan: 'two_day', user_id: 'user-a' } } },
  };
  const threeMonth = {
    id: 'evt_three_month', type: 'payment_intent.succeeded',
    created: Date.parse('2026-03-01T12:00:00Z') / 1000,
    data: { object: { amount_received: 3999, currency: 'usd', customer: 'cus_b',
      metadata: { membership_plan: 'three_month', user_id: 'user-b' } } },
  };

  assert.equal((await handleStripeWebhookEvent(twoDay, {
    stripe: {}, supabaseAdmin: db, subscriberNotifier: async () => {}, linkedinDelivery: async () => {},
  })).applied, true);
  assert.equal((await handleStripeWebhookEvent(threeMonth, {
    stripe: {}, supabaseAdmin: db, subscriberNotifier: async () => {}, linkedinDelivery: async () => {},
  })).applied, true);

  const two = updates.find((u) => u.subscription_cancel_at === '2026-03-03T12:00:00.000Z');
  const three = updates.find((u) => u.subscription_cancel_at === '2026-06-01T12:00:00.000Z');
  assert.ok(two && two.subscription_status === 'active');
  assert.ok(three && three.subscription_status === 'active');
  assert.equal(hasFullAccess({ subscription_status: 'active', subscription_cancel_at: '2026-03-03T12:00:00.000Z' }), false);
  assert.equal(hasFullAccess({ subscription_status: 'active', subscription_cancel_at: '2099-01-01T00:00:00Z' }), true);
  assert.equal(MEMBERSHIP_PLANS.monthly.kind, 'subscription');
  assert.equal(accessEnd(MEMBERSHIP_PLANS.two_day, new Date('2026-03-01T12:00:00Z')), '2026-03-03T12:00:00.000Z');
});

test('ingestion health summary flags stale and failed runs without noisy ok=true', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const healthy = summarizeIngestionHealth([{
    id: 'r1', status: 'completed', started_at: '2026-10-08T01:00:00Z', ended_at: '2026-10-08T02:00:00Z',
    summary: { employers_checked: 40, jobs_inserted: 12, jobs_updated: 5, failed: 1 },
  }], { active: 200, never_checked: 3, held: 1 }, { problem: null, failure_count: 0 }, now);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.last_run.employers_checked, 40);
  assert.equal(healthy.stale_ingestion, false);

  const stale = summarizeIngestionHealth([{
    id: 'r2', status: 'completed', started_at: '2026-09-01T01:00:00Z', ended_at: '2026-09-01T02:00:00Z',
    summary: {},
  }], { active: 200, never_checked: 0, held: 0 }, null, now);
  assert.equal(stale.ok, false);
  assert.equal(stale.stale_ingestion, true);

  const failed = summarizeIngestionHealth([{
    id: 'r3', status: 'failed', started_at: '2026-10-08T01:00:00Z', ended_at: '2026-10-08T01:10:00Z',
    summary: { failed: 9 },
  }], { active: 10, never_checked: 0, held: 0 }, { problem: 'Latest run failed', failure_count: 2 }, now);
  assert.equal(failed.ok, false);
  assert.match(failed.watchdog.problem, /failed/i);
});
