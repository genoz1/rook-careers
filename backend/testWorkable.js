const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeWorkableJob, workableLocation } = require('./adapters/workable');

const employer = { id: 'e1', company_name: 'Ascendis Pharma' };

test('single-location posting: falls back to the primary location object (the common case)', () => {
  const raw = {
    id: 1,
    title: 'Territory Business Manager',
    url: 'https://apply.workable.com/ascendis-pharma/j/AAA/',
    location: { location_str: 'Denver, CO', city: 'Denver', state_code: 'CO' },
  };
  const row = normalizeWorkableJob(raw, employer);
  assert.equal(row.location_raw, 'Denver, CO');
});

test('multi-location posting: every distinct location in the `locations` array is preserved, none dropped', () => {
  const raw = {
    id: 2,
    title: 'Regional Sales Director, Endocrinology',
    url: 'https://apply.workable.com/ascendis-pharma/j/BBB/',
    // A national/multi-state territory posting is what the prior "dropped
    // locations" report described — Workable's own schema carries every
    // location here, not just one "primary" one.
    location: { location_str: 'Denver, CO', city: 'Denver', state_code: 'CO' },
    locations: [
      { location_str: 'Denver, CO', city: 'Denver', state_code: 'CO' },
      { location_str: 'Chicago, IL', city: 'Chicago', state_code: 'IL' },
      { location_str: 'Dallas, TX', city: 'Dallas', state_code: 'TX' },
    ],
  };
  const row = normalizeWorkableJob(raw, employer);
  assert.equal(row.location_raw, 'Denver, CO | Chicago, IL | Dallas, TX');
});

test('workableLocation never substitutes a single headquarters location for an unresolved multi-state territory', () => {
  const raw = {
    locations: [
      { location_str: 'Copenhagen, Denmark' }, // HQ, listed alongside real US territory entries
      { city: 'Austin', state_code: 'TX' },
      { city: 'Miami', state_code: 'FL' },
    ],
  };
  const label = workableLocation(raw);
  assert(label.includes('Copenhagen, Denmark'));
  assert(label.includes('Austin, TX'));
  assert(label.includes('Miami, FL'));
  // All three survive — none silently dropped in favor of one.
  assert.equal(label.split(' | ').length, 3);
});

test('remote posting with no city/state falls back to a Remote label rather than an empty string', () => {
  const raw = { location: { telecommuting: true, country_name: 'United States' } };
  assert.equal(workableLocation(raw), 'United States');
  assert.equal(workableLocation({ location: { telecommuting: true } }), 'Remote');
});

test('empty/missing location data never throws — returns an empty string, not null/undefined', () => {
  assert.equal(workableLocation({}), '');
  assert.equal(normalizeWorkableJob({ id: 3, title: 'X', url: 'https://apply.workable.com/x/j/1/' }, employer).location_raw, '');
});

test('duplicate location entries in `locations` collapse to one, not repeated', () => {
  const raw = {
    locations: [
      { location_str: 'Boston, MA' },
      { location_str: 'Boston, MA' },
    ],
  };
  assert.equal(workableLocation(raw), 'Boston, MA');
});


test('observed widget country fields preserve India and country-only US postings', () => {
  assert.equal(workableLocation({ locations: [{city: 'Noida', region: 'Uttar Pradesh', country: 'India', countryCode: 'IN'}] }), 'Noida, Uttar Pradesh, India');
  assert.equal(workableLocation({ locations: [{city: '', country: 'United States', countryCode: 'US'}] }), 'United States');
});
