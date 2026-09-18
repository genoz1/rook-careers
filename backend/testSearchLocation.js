const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const zipcodes = require('zipcodes');
const routes = {};
let externalCalls = 0;
const router = { get(route, ...handlers) { routes[route] = handlers; } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'routes/geocode.js'), 'utf8'), {
  module: { exports: {} },
  require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === 'zipcodes') return zipcodes;
    if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getUser: async token => ({ data: { user: token === 'valid' ? { id: 'test' } : null } }) } }) };
    if (name === '../geocoding') return { geocodeLocation: async () => { externalCalls++; return null; } };
    throw Error(name);
  },
  process: { env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'test' } },
  setImmediate: fn => fn(), setInterval() {},
});
async function request(q, token = 'valid') {
  let status = 200, body;
  const req = { query: { q }, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { status(code) { status = code; return res; }, json(data) { body = data; return res; } };
  let authenticated = false;
  await routes['/geocode'][0](req, res, () => { authenticated = true; });
  if (authenticated) await routes['/geocode'][1](req, res);
  return { status, body };
}
(async () => {
  for (const [query, city, state] of [
    ['34484', 'Oxford', 'Florida'], ['34484-1234', 'Oxford', 'Florida'],
    ['02108', 'Boston', 'Massachusetts'], ['Seattle', 'Seattle', 'Washington'],
    ['Tampa, FL', 'Tampa', 'Florida'], ['tampa fl', 'Tampa', 'Florida'],
    ['Tampa, Florida', 'Tampa', 'Florida'], ['New York New York', 'New York', 'New York'],
    ['Boise, ID', 'Boise', 'Idaho'],
  ]) {
    const result = await request(query);
    assert.equal(result.status, 200, query);
    assert.equal(result.body.city, city, query);
    assert.equal(result.body.state, state, query);
    assert.ok(Number.isFinite(result.body.lat) && Number.isFinite(result.body.lng));
    if (/^\d/.test(query)) {
      const expected = zipcodes.lookup(query.slice(0, 5));
      assert.equal(result.body.lat, expected.latitude);
      assert.equal(result.body.lng, expected.longitude);
    }
  }
  assert.equal(externalCalls, 0, 'Normal U.S. searches must not need the external service');
  assert.equal((await request('Springfield')).status, 400);
  assert.equal((await request('00000')).status, 404);
  assert.equal((await request('')).status, 400);
  assert.equal((await request('34484', '')).status, 401);
  assert.equal((await request('34484', 'expired')).status, 401);
  assert.equal((await request('Toronto, Canada')).status, 404);
  assert.equal(externalCalls, 1);
  console.log('Passed 15 location-search cases, including ZIPs, cities, ambiguity, invalid input and authentication.');
})().catch(error => { console.error(error); process.exitCode = 1; });
