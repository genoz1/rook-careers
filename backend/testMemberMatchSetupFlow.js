const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function load(documentStub) {
  const sandbox = {
    console,
    document: documentStub || {
      getElementById() { return null; },
      querySelectorAll() { return []; },
      createElement() { return {}; },
      body: { appendChild() {}, classList: { add() {}, remove() {} } },
    },
    module: { exports: {} },
    exports: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'public/rook-job-classification.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'public/rook-match-setup.js'), 'utf8'),
    sandbox,
    { filename: 'match-setup-flow.js' }
  );
  return sandbox.RookMatchSetup;
}

test('location payload saves city ZIP territory and never invents nationwide', () => {
  const RookMatchSetup = load({
    querySelectorAll(sel) {
      if (String(sel).includes('matchSetupTerritories')) {
        return [{ value: 'local' }, { value: 'regional' }];
      }
      return [];
    },
    getElementById() { return null; },
  });
  const payload = RookMatchSetup._test.buildLocationPayload({
    nationwide: false,
    location: {
      label: 'Oxford, FL', city: 'Oxford', state: 'FL', stateAbbr: 'FL',
      lat: 28.923, lng: -82.045, zip: '34484',
    },
  });
  assert.equal(payload.home_zip, '34484');
  assert.equal(payload.home_state, 'FL');
  assert.equal(payload.home_location_label, 'Oxford, FL');
  assert.equal(JSON.stringify(payload.territory_size_preferences), JSON.stringify(['local', 'regional']));
  assert.notEqual(payload.home_location_label, 'Across the U.S.');
});

test('nationwide requires an explicit checkbox and still saves territory', () => {
  const RookMatchSetup = load({
    querySelectorAll(sel) {
      if (String(sel).includes('matchSetupTerritories')) return [{ value: 'national' }, { value: 'remote' }];
      return [];
    },
    getElementById() { return null; },
  });
  const payload = RookMatchSetup._test.buildLocationPayload({ nationwide: true, location: null });
  assert.equal(payload.home_location_label, 'Across the U.S.');
  assert.equal(payload.home_lat, null);
  assert.equal(JSON.stringify(payload.territory_size_preferences), JSON.stringify(['national', 'remote']));
});

test('industry payload rejects unanswered state and accepts explicit All', () => {
  const emptyDoc = {
    getElementById(id) {
      if (id === 'matchSetupAllIndustries') return { checked: false };
      return null;
    },
    querySelectorAll(sel) {
      if (String(sel).includes('matchSetupIndustries')) return [];
      return [];
    },
  };
  const RookMatchSetup = load(emptyDoc);
  assert.throws(
    () => RookMatchSetup._test.buildIndustryPayload({ allIndustries: false }),
    /Select at least one industry/
  );

  const allDoc = {
    getElementById(id) {
      if (id === 'matchSetupAllIndustries') return { checked: true };
      return null;
    },
    querySelectorAll() { return []; },
  };
  const allSetup = load(allDoc);
  const allPayload = allSetup._test.buildIndustryPayload({ allIndustries: true });
  assert.equal(allPayload.desired_industries.length, allSetup.INDUSTRIES.length);
  assert.ok(allPayload.desired_industries.includes('Veterinary'));
});

test('skipping résumé is unrelated to needsSetup — prefs alone clear the gate', () => {
  const RookMatchSetup = load();
  const afterPrefs = {
    home_location_label: 'Oxford, FL',
    home_city: 'Oxford',
    home_state: 'FL',
    home_zip: '34484',
    home_lat: 28.9,
    home_lng: -82.0,
    desired_industries: ['Veterinary'],
    territory_size_preferences: ['local'],
    resume_file_path: null,
  };
  assert.equal(RookMatchSetup.needsSetup(afterPrefs), false);
});
