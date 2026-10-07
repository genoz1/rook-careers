const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/medreps-alternative.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/medreps-alternative.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/medreps-alternative.css'), 'utf8');

test('public metadata, sitemap and V8 entry stay aligned', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/rookcareers\.com\/medreps-alternative">/);
  assert.doesNotMatch(html, /noindex/);
  assert.match(fs.readFileSync(path.join(root, 'backend/routes/publicPages.js'), 'utf8'), /\$\{APP_BASE_URL\}\/medreps-alternative/);
  const links = [...html.matchAll(/data-cta="([^"]+)" href="([^"]+)"/g)];
  assert.deepEqual(links.map(m => m[1]), ['hero','comparison','alongside','final']);
  assert(links.every(m => m[2] === '/rook-onboarding-v8.html'));
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /@media\(max-width:360px\)/);
});

test('each CTA preserves campaign values and creates one event on click', async () => {
  const events = [], storage = new Map();
  const links = ['hero','comparison','alongside','final'].map(cta => ({dataset:{cta},href:'',handler:null,getAttribute(){return '/rook-onboarding-v8.html'},addEventListener(name,handler){assert.equal(name,'click');this.handler=handler}}));
  const offer = {hidden:true,textContent:''};
  const context = {URL,URLSearchParams,location:{origin:'https://rookcareers.com',search:'?utm_source=google&utm_campaign=medreps_search&gclid=abc123'},sessionStorage:{setItem:(k,v)=>storage.set(k,v)},document:{querySelectorAll:()=>links,getElementById:()=>offer},gtag:(...args)=>events.push(args)};
  vm.runInNewContext(script,context);
  await new Promise(setImmediate);
  assert.equal(storage.get('rook_acquisition_origin'),'medreps-alternative');
  assert.equal(events.filter(e=>e[1]==='medreps_alternative_view').length,1);
  for (const link of links) {
    assert.equal(link.href,'/rook-onboarding-v8.html?utm_source=google&utm_campaign=medreps_search&gclid=abc123');
    link.handler();
  }
  assert.equal(events.filter(e=>e[1]==='medreps_alternative_cta_click').length,4);
  assert.equal(offer.textContent,'Preview current protected matches first. Paid access starts at $5.99.');
  assert.equal(offer.hidden,false);
});

test('V8 conversion names remain intact and origin is event context only', () => {
  const tracker = fs.readFileSync(path.join(root, 'public/rook-v8-tracking.js'), 'utf8');
  const v8 = fs.readFileSync(path.join(root, 'public/rook-v8.js'), 'utf8');
  for (const name of ['v8_signup_started','v8_account_created','v8_checkout_started','v8_trial_started']) assert(tracker.includes(name));
  for (const name of ['v8_dashboard_impression','v8_preview_dashboard_displayed','v8_show_my_jobs_requested']) assert(v8.includes(name));
  assert.match(tracker,/safe\.acquisition_page = 'medreps-alternative'/);
  assert.match(v8,/acquisition_page:'medreps-alternative'/);
  assert(!script.includes("gtag('event', 'sign_up'"));
});
