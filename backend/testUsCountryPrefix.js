const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mentionsNonUsCountry } = require('./matching');

test('US-prefixed Workday locations remain domestic', () => {
  for (const location of ['US - Field', 'US - Texas', 'US - California - Southern - Remote']) {
    assert.equal(mentionsNonUsCountry(location, null, 'Account Manager'), false, location);
  }
});

test('foreign country prefixes still exclude foreign postings', () => {
  assert.equal(mentionsNonUsCountry('GB - London', null, 'Account Manager'), true);
  assert.equal(mentionsNonUsCountry('FR - Paris', null, 'Account Manager'), true);
});
