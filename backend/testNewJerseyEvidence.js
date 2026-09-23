const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasUnambiguousForeignCountryEvidence: foreign } = require('./locationTextRules');

test('New Jersey and Jersey City do not collide with Jersey', () => {
  for (const location of ['New Jersey', 'Jersey City, NJ', 'New Jersey, United States', 'Northern New Jersey territory', 'Boston, MA', 'California, USA']) {
    assert.equal(foreign(location), false, location);
  }
});
test('foreign Jersey and conflicting foreign evidence remain excluded', () => {
  for (const location of ['Jersey', 'Saint Helier, Jersey', 'Jersey, Channel Islands', 'New Jersey / Jersey', 'Jersey City / Canada', 'New Jersey / France', 'London, United Kingdom']) {
    assert.equal(foreign(location), true, location);
  }
});
