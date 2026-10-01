const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const obsoleteOffer = /3[- ]day free trial|free (?:trial )?for 3 days|3 days free|after (?:your )?3[- ]day trial|card required (?:at checkout|to start)|card-required/i;

test('current public acquisition surfaces use the canonical no-card offer', () => {
  for (const file of [
    'public/index.html',
    'public/rook-login.html',
    'public/rook-pricing.html',
    'public/rook-trial-banner.js',
    'public/medreps-alternative.js',
    'public/rook-pretrial.js',
    'public/rook-browse.html',
    'public/rook-dashboard.html',
    'public/rook-dashboard-v7.html',
    'public/rook-mobile-menu.html',
    'backend/routes/publicPages.js',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, obsoleteOffer, file);
    assert.match(source, /Try ROOK Today for Free|24 hours of full access/i, file);
  }
  assert.doesNotMatch(read('public/medreps-alternative.html'), obsoleteOffer);
});

test('pricing communicates the complete canonical progression without creating a Stripe trial', () => {
  const pricing = read('public/rook-pricing.html');
  assert.match(pricing, /24 hours of full access\. No credit card required\./i);
  assert.match(pricing, /\$9\.99 for your first 30 paid days/i);
  assert.match(pricing, /then \$19\.99\/month/i);
  assert.match(pricing, /Cancel anytime/i);
  assert.match(pricing, /rook-onboarding-v8\.html/);
  assert.doesNotMatch(pricing, /create-checkout-session|trial-config|\$249|annual-note/);
});

test('legacy acquisition endpoints are retired into V8 and preserve the query string', () => {
  const server = read('server.js');
  assert.match(server, /"\/rook-onboarding\.html", \.\.\.\[2, 3, 4, 5, 6, 7\]/);
  for (const route of [
    '/rook-checkout.html',
    '/rook-checkout-v7.html',
    '/rook-onboarding-v6-signup.html',
    '/rook-onboarding-v7-signup.html',
  ]) assert.ok(server.includes(route), route);
  assert.match(server, /res\.redirect\(302, "\/rook-onboarding-v8\.html" \+ query\)/);
  assert.match(server, /Cache-Control", "no-store/);
});

test('the legacy Stripe trial switch is disabled and deprecated', () => {
  const stripe = read('backend/routes/stripe.js');
  assert.doesNotMatch(read('.env.example'), /^TRIAL_PERIOD_DAYS=/m);
  assert.match(stripe, /function getTrialPeriodDays\(\) \{\s*return 0;\s*\}/);
  assert.match(stripe, /res\.json\(\{ trialDays: 0, deprecated: true \}\)/);
  assert.match(stripe, /function buildCheckoutSessionParams\(\{ trialDays: _legacyTrialDays/);
  assert.match(stripe, /const trialDays = 0;/);
});

test('non-subscriber email destinations enter V8 and keep unsubscribe handling intact', () => {
  const daily = read('backend/email/dailyDigest.js');
  const pretrial = read('backend/email/pretrialDigest.js');
  assert.match(daily, /rook-onboarding-v8\.html/);
  assert.doesNotMatch(daily, /rook-pricing\.html/);
  assert.match(pretrial, /rook-onboarding-v8\.html\?from=job_alert/);
  assert.doesNotMatch(pretrial, /rook-dashboard-v7\.html\?from=job_alert/);
  assert.match(pretrial, /alerts\/unsubscribe/);
});

test('shared expired-trial destination and approved offer remain intact', () => {
  const page = read('public/rook-keep-access.html');
  assert.match(page, /KEEP YOUR ROOK ACCESS/i);
  assert.match(page, /First 30 paid days[^$]*\$9\.99/i);
  assert.match(page, /Thereafter[^$]*\$19\.99\/month/i);
  for (const file of ['public/rook-access.js', 'public/rook-access-context.js', 'public/rook-auth.js']) {
    assert.match(read(file), /rook-keep-access\.html/, file);
  }
});
