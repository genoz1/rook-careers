// Facebook relaunch readiness: routing stays on current V8 surfaces,
// Meta pixel maps paid conversion to Purchase, and UTMs/fbclid persist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('V8/V9 entry routes intentionally serve the current masked/paid funnel', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/rook-onboarding-v8\.html'[\s\S]*rook-acquisition\.html/);
  assert.match(server, /app\.get\('\/rook-checkout-v8\.html'[\s\S]*rook-checkout-current\.html/);
  assert.match(server, /app\.get\('\/rook-pricing\.html'[\s\S]*rook-pricing-current\.html/);
  assert.match(server, /\/rook-onboarding-v9\.html'[\s\S]*redirect\(302/);
  assert.match(server, /\/rook-keep-access\.html'[\s\S]*\/rook-checkout-v8\.html/);
  // Do not treat "v8" in the URL as prohibited — these routes are current.
  assert.match(server, /rook-onboarding-v8\.html/);
});

test('current pricing is 48h \$5.99 / monthly \$9.99→\$19.99 / 90-day \$39.99 with no free trial', () => {
  const pricing = read('public/rook-pricing-current.html');
  const checkout = read('public/rook-checkout-current.html');
  for (const text of [pricing, checkout]) {
    assert.match(text, /\$5\.99/);
    assert.match(text, /\$9\.99/);
    assert.match(text, /\$19\.99/);
    assert.match(text, /\$39\.99/);
    assert.match(text, /48 hours|2-Day Pass/i);
    assert.match(text, /3-Month Pass|3 months/i);
    assert.doesNotMatch(text, /free trial|no credit card required|Try ROOK Today for Free/i);
  }
});

test('Meta pixel 1597398388509281 maps current paid events to Purchase not Subscribe/StartTrial', () => {
  const tracking = read('public/rook-v8-tracking.js');
  assert.match(tracking, /1597398388509281/);
  assert.match(tracking, /successful_paid_conversion:\s*\['trackSingle',\s*'Purchase'\]/);
  assert.match(tracking, /checkout_started:\s*\['trackSingle',\s*'InitiateCheckout'\]/);
  assert.match(tracking, /protected_dashboard_viewed:\s*\['trackSingle',\s*'ViewContent'\]/);
  // No live event keys may still emit StartTrial/Subscribe to Meta.
  assert.doesNotMatch(tracking, /:\s*\['trackSingle',\s*'StartTrial'\]/);
  assert.doesNotMatch(tracking, /:\s*\['trackSingle',\s*'Subscribe'\]/);
  assert.match(tracking, /planValues[\s\S]*two_day:\s*5\.99/);
  assert.match(tracking, /monthly:\s*9\.99/);
  assert.match(tracking, /three_month:\s*39\.99/);
});

test('pricing and checkout load attribution + pixel for Facebook landings', () => {
  const pricing = read('public/rook-pricing-current.html');
  const checkout = read('public/rook-checkout-current.html');
  assert.match(pricing, /rook-attribution\.js/);
  assert.match(pricing, /rook-v8-tracking\.js/);
  assert.match(checkout, /rook-attribution\.js/);
  assert.match(checkout, /rook-v8-tracking\.js/);
});

test('Purchase fires once with plan value and ignores duplicate calls', () => {
  const calls = [];
  const memory = new Map();
  const ctx = {
    window: {
      fbq(...args) { calls.push(args); },
      gtag() {},
    },
    sessionStorage: {
      getItem: (k) => memory.get(k) || null,
      setItem: (k, v) => memory.set(k, v),
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
    },
    document: {
      createElement: () => ({ async: false, src: '' }),
      head: { appendChild() {} },
    },
  };
  ctx.window.fbq.calls = calls;
  vm.createContext(ctx);
  vm.runInContext(read('public/rook-v8-tracking.js'), ctx);
  ctx.window.rookTrackFunnelEvent('successful_paid_conversion', { plan: 'two_day' });
  ctx.window.rookTrackFunnelEvent('successful_paid_conversion', { plan: 'two_day' });
  const purchases = calls.filter((args) => args[2] === 'Purchase');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0][3].currency, 'USD');
  assert.equal(purchases[0][3].value, 5.99);
  assert.ok(calls.some((args) => args[2] === 'PageView'));
});
