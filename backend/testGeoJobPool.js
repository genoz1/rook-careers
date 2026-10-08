const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fetchGeoScopedJobPool, resolveHomeStateParts } = require('./geoJobPool');

function mockDb(rows) {
  return {
    from() {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push((row) => row[col] === val); return q; },
        gte(col, val) { filters.push((row) => row[col] != null && row[col] >= val); return q; },
        lte(col, val) { filters.push((row) => row[col] != null && row[col] <= val); return q; },
        is(col, val) { filters.push((row) => (val === null ? row[col] == null : row[col] === val)); return q; },
        ilike(col, pattern) {
          const needle = String(pattern).replace(/%/g, '').toLowerCase();
          filters.push((row) => String(row[col] || '').toLowerCase().includes(needle));
          return q;
        },
        or(expr) {
          // Support remote supplement: remote_status.eq.remote OR null+Remote text
          filters.push((row) => {
            if (row.remote_status === 'remote') return true;
            if (row.job_lat == null && /remote/i.test(row.location_raw || '')) return true;
            return false;
          });
          void expr;
          return q;
        },
        order() { return q; },
        range(a, b) {
          const matched = rows.filter((row) => filters.every((fn) => fn(row)));
          return Promise.resolve({ data: matched.slice(a, b + 1), error: null });
        },
      };
      return q;
    },
  };
}

test('resolveHomeStateParts accepts full names and abbreviations', () => {
  assert.deepEqual(resolveHomeStateParts('Florida'), { name: 'Florida', abbr: 'FL' });
  assert.deepEqual(resolveHomeStateParts('FL'), { name: 'Florida', abbr: 'FL' });
  assert.deepEqual(resolveHomeStateParts('new york'), { name: 'New York', abbr: 'NY' });
  assert.deepEqual(resolveHomeStateParts(null), { name: null, abbr: null });
});

test('fetchGeoScopedJobPool always boxes and never returns the full table for broad prefs', async () => {
  const tampa = { id: 'tampa', job_lat: 27.95, job_lng: -82.46, location_raw: 'Tampa, FL', remote_status: null };
  const miami = { id: 'miami', job_lat: 25.76, job_lng: -80.19, location_raw: 'Miami, Florida', remote_status: null };
  const seattle = { id: 'seattle', job_lat: 47.6, job_lng: -122.3, location_raw: 'Seattle, WA', remote_status: null };
  const pipeFl = { id: 'pipe', job_lat: 33.75, job_lng: -84.39, location_raw: 'Atlanta, GA | Orlando, FL, USA', remote_status: null };
  const nullFl = { id: 'null-fl', job_lat: null, job_lng: null, location_raw: 'Remote Office | Florida, USA', remote_status: null };
  const remote = { id: 'remote', job_lat: null, job_lng: null, location_raw: 'Remote, United States', remote_status: 'remote' };
  const farNull = { id: 'far-null', job_lat: null, job_lng: null, location_raw: 'Somewhere, AK', remote_status: null };
  const rows = [tampa, miami, seattle, pipeFl, nullFl, remote, farNull];
  // Pad with noise so a naive full-table fetch would be obvious.
  for (let i = 0; i < 200; i++) {
    rows.push({ id: 'noise-' + i, job_lat: 40 + (i % 10), job_lng: -90, location_raw: 'Noise, OH', remote_status: null });
  }

  const db = mockDb(rows);
  const createQuery = () => db.from('jobs').select('*').eq('status', 'active');
  // Attach status for eq filter compatibility
  for (const row of rows) row.status = 'active';

  const local = await fetchGeoScopedJobPool({
    createQuery,
    lat: 27.95,
    lng: -82.46,
    homeState: 'Florida',
    allowBroad: false,
  });
  assert.equal(local.error, null);
  const localIds = new Set(local.data.map((j) => j.id));
  assert(localIds.has('tampa'));
  assert(localIds.has('miami'));
  assert(localIds.has('null-fl'));
  assert(localIds.has('pipe'));
  assert(!localIds.has('seattle'));
  assert(!localIds.has('far-null'));
  assert(!localIds.has('noise-0'));
  assert(local.data.length < 50);

  const broad = await fetchGeoScopedJobPool({
    createQuery,
    lat: 27.95,
    lng: -82.46,
    homeState: 'FL',
    allowBroad: true,
  });
  const broadIds = new Set(broad.data.map((j) => j.id));
  assert(broadIds.has('remote'));
  assert(!broadIds.has('seattle'));
  assert(broad.data.length < 80);
});

test('member dashboard does not block first paint on recruiter-jobs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rook-dashboard-v8.html'), 'utf8');
  assert.match(html, /const recruiterPromise = rookApiFetch\('\/recruiter-jobs'\)/);
  assert.match(html, /Fold recruiter-posted extras in after first paint/);
  assert.match(html, /jobList\.style\.display = 'none';\s*loading\.style\.display = '';/);
  // Recruiter merge must come after revealDemo / first paint.
  const paint = html.indexOf('revealDemo();');
  const merge = html.indexOf('Fold recruiter-posted extras in after first paint');
  assert.ok(paint > 0 && merge > paint);
});

test('jobs route uses geo-scoped pool instead of broad-pref full scan', () => {
  const source = fs.readFileSync(path.join(__dirname, 'routes', 'jobs.js'), 'utf8');
  assert.match(source, /fetchGeoScopedJobPool/);
  assert.match(source, /Do NOT skip the box when allowsBroadLocations/);
  assert.equal(source.includes('location_raw.ilike.%|%'), false, 'nationwide pipe OR removed from live path');
  assert.equal(source.includes('!allowsBroadLocations(profile)'), false, 'broad prefs must not skip the box');
});
