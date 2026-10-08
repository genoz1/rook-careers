const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const setupSource = fs.readFileSync(path.join(root, 'public/rook-match-setup.js'), 'utf8');
const classSource = fs.readFileSync(path.join(root, 'public/rook-job-classification.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public/rook-dashboard-v8.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/rook-v8-member.css'), 'utf8');

function loadSetup() {
  const sandbox = { console, module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(classSource + '\n' + setupSource, sandbox, { filename: 'rook-match-setup.js' });
  return sandbox.RookMatchSetup || sandbox.module.exports;
}

const COMPLETE_LOCAL = {
  home_location_label: 'Oxford, FL',
  home_city: 'Oxford',
  home_state: 'FL',
  home_zip: '34484',
  home_lat: 28.9,
  home_lng: -82.0,
  desired_industries: ['Medical Device', 'Veterinary'],
  territory_size_preferences: ['local', 'regional'],
};

test('A: brand-new bootstrap (Across the U.S. + empty industries) requires match setup', () => {
  const RookMatchSetup = loadSetup();
  const bootstrap = {
    home_location_label: 'Across the U.S.',
    home_lat: null,
    home_lng: null,
    home_zip: null,
    desired_industries: [],
    territory_size_preferences: ['remote', 'national'],
  };
  assert.equal(RookMatchSetup.needsSetup(bootstrap), true);
  assert.equal(RookMatchSetup.missingLocation(bootstrap), true);
  assert.equal(RookMatchSetup.missingIndustry(bootstrap), true);
  assert.equal(RookMatchSetup.missingTerritory(bootstrap), true);
});

test('B: established account with saved city preferences does not reopen setup', () => {
  const RookMatchSetup = loadSetup();
  assert.equal(RookMatchSetup.needsSetup(COMPLETE_LOCAL), false);
  assert.equal(RookMatchSetup.missingLocation(COMPLETE_LOCAL), false);
  assert.equal(RookMatchSetup.missingIndustry(COMPLETE_LOCAL), false);
  assert.equal(RookMatchSetup.missingTerritory(COMPLETE_LOCAL), false);
});

test('C: established account missing only industry is prompted for industry only', () => {
  const RookMatchSetup = loadSetup();
  const profile = {
    home_location_label: 'Boston, MA',
    home_city: 'Boston',
    home_state: 'MA',
    home_zip: '02108',
    home_lat: 42.36,
    home_lng: -71.06,
    desired_industries: [],
    territory_size_preferences: ['local'],
  };
  assert.equal(RookMatchSetup.needsSetup(profile), true);
  assert.equal(RookMatchSetup.missingLocation(profile), false);
  assert.equal(RookMatchSetup.missingIndustry(profile), true);
  const seeded = RookMatchSetup._test.seedState(profile);
  assert.equal(seeded.step, 'industry');
  assert.equal(seeded.skipLocation, true);
});

test('D/G: explicit nationwide + industries + territory does not reopen setup after login', () => {
  const RookMatchSetup = loadSetup();
  const nationwide = {
    home_location_label: 'Across the U.S.',
    home_lat: null,
    home_lng: null,
    home_city: null,
    home_state: null,
    home_zip: null,
    desired_industries: ['Medical Device', 'Pharmaceutical'],
    territory_size_preferences: ['national', 'remote'],
  };
  assert.equal(RookMatchSetup._test.isExplicitNationwide(nationwide), true);
  assert.equal(RookMatchSetup.missingLocation(nationwide), false);
  assert.equal(RookMatchSetup.missingIndustry(nationwide), false);
  assert.equal(RookMatchSetup.missingTerritory(nationwide), false);
  assert.equal(RookMatchSetup.needsSetup(nationwide), false);
});

test('H: explicit All industries (full taxonomy) is a valid saved preference', () => {
  const RookMatchSetup = loadSetup();
  const all = RookMatchSetup.INDUSTRIES.map((i) => i.value);
  const profile = {
    ...COMPLETE_LOCAL,
    desired_industries: all,
  };
  assert.equal(RookMatchSetup.missingIndustry(profile), false);
  assert.equal(RookMatchSetup.needsSetup(profile), false);
  const seeded = RookMatchSetup._test.seedState(profile);
  assert.equal(seeded.allIndustries, true);
});

test('F: null / failed profile fetch must not trigger setup', () => {
  const RookMatchSetup = loadSetup();
  assert.equal(RookMatchSetup.needsSetup(null), false);
  assert.equal(RookMatchSetup.needsSetup(undefined), false);
});

test('legacy city location without ZIP still counts as saved (not blank)', () => {
  const RookMatchSetup = loadSetup();
  const legacy = {
    home_location_label: 'Tampa, FL',
    home_city: 'Tampa',
    home_state: 'FL',
    home_zip: null,
    home_lat: 27.95,
    home_lng: -82.46,
    desired_industries: ['Veterinary'],
    territory_size_preferences: ['local'],
  };
  assert.equal(RookMatchSetup._test.hasLocalLocation(legacy), true);
  assert.equal(RookMatchSetup.missingLocation(legacy), false);
  assert.equal(RookMatchSetup.needsSetup(legacy), false);
});

test('IP bootstrap territory defaults are treated as unconfirmed until industry is chosen', () => {
  const RookMatchSetup = loadSetup();
  const profile = {
    home_location_label: 'Tampa, FL',
    home_city: 'Tampa',
    home_state: 'FL',
    home_zip: '33602',
    home_lat: 27.95,
    home_lng: -82.46,
    desired_industries: [],
    territory_size_preferences: ['remote', 'national'],
  };
  assert.equal(RookMatchSetup.missingTerritory(profile), true);
  assert.equal(RookMatchSetup.needsSetup(profile), true);
});

test('bootstrap remote+national becomes valid once industries are saved', () => {
  const RookMatchSetup = loadSetup();
  const profile = {
    home_location_label: 'Across the U.S.',
    home_zip: null,
    home_lat: null,
    home_lng: null,
    desired_industries: ['Diagnostics'],
    territory_size_preferences: ['remote', 'national'],
  };
  assert.equal(RookMatchSetup.missingTerritory(profile), false);
  assert.equal(RookMatchSetup.needsSetup(profile), false);
});

test('explicit All industries persists the full taxonomy rather than an empty array', () => {
  const RookMatchSetup = loadSetup();
  const values = RookMatchSetup.INDUSTRIES.map((i) => i.value);
  assert.ok(values.includes('Veterinary'));
  assert.ok(values.includes('Medical Device'));
  assert.equal(values.length >= 9, true);
});

test('dashboard wires match setup before résumé gate and job load', () => {
  assert.match(dashboard, /rook-match-setup\.js\?v=3/);
  assert.match(dashboard, /RookMatchSetup\.needsSetup/);
  assert.match(dashboard, /RookMatchSetup\.run/);
  assert.match(dashboard, /await profileBootstrap/);
  assert.match(dashboard, /profile && RookMatchSetup\.needsSetup\(profile\)/);
  const setupAt = dashboard.indexOf('RookMatchSetup.needsSetup');
  const resumeHandlerAt = dashboard.indexOf("const missingResume = !profile.resume_file_path");
  const loadAt = dashboard.indexOf('await loadJobs()');
  assert.ok(setupAt > 0 && resumeHandlerAt > setupAt, 'match setup runs before résumé gate handler');
  assert.ok(loadAt > dashboard.indexOf('await profileBootstrap'), 'jobs wait for bootstrap');
  assert.match(dashboard, /Skip for Now/);
  assert.ok(!dashboard.includes("You're missing a résumé and a primary location"));
});

test('résumé popup CSS keeps controls clickable and above page chrome', () => {
  assert.match(css, /z-index:\s*1200/);
  assert.match(css, /\.profile-gate-card \.dismiss\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.profile-gate-card \.dismiss\{[^}]*min-height:\s*44px/);
  assert.match(css, /match-setup-overlay/);
  assert.ok(!/font:[^;]*Caveat/.test(css));
});

test('industry step uses a compact two-column layout that avoids card scrolling', () => {
  const setup = fs.readFileSync(path.join(root, 'public/rook-match-setup.js'), 'utf8');
  assert.match(setup, /setCardMode\('industry'\)/);
  assert.match(setup, /match-setup-industry-grid/);
  assert.match(css, /\.match-setup-card\.is-industry/);
  assert.match(css, /grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /\.match-setup-card\.is-industry\{[^}]*overflow:\s*hidden/);
});

test('New Matches Today uses the loaded job set, not an unscoped platform count', () => {
  const start = dashboard.indexOf('async function updateStats(jobs)');
  const end = dashboard.indexOf('function isRemoteJob', start);
  assert.ok(start >= 0 && end > start, 'updateStats block found');
  const statsFn = dashboard.slice(start, end);
  assert.match(statsFn, /startOfToday/);
  assert.match(statsFn, /statNewMatches/);
  assert.ok(!statsFn.includes("rookApiFetch('/new-matches-today-count')"));
  assert.ok(!statsFn.includes('rookApiFetch("/new-matches-today-count")'));
});

test('V8 claim preserves established preferences instead of wiping with bootstrap blanks', () => {
  const source = fs.readFileSync(path.join(root, 'backend/routes/onboardingV8.js'), 'utf8');
  assert.match(source, /Never wipe an established member's saved match preferences/);
  assert.match(source, /existingIndustries/);
  assert.match(source, /incomingNationwide/);
  assert.match(source, /select\('\*'\)\.eq\('user_id'/);
});
