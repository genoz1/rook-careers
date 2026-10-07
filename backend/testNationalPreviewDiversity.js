const test = require('node:test');
const assert = require('node:assert/strict');
const { diversifyNationalPreview } = require('./v8Matching');
const { generalizedRole } = require('./maskedPresentation');

function job(id, title, city, state, industry, daysAgo = 0) {
  const posted = new Date(Date.UTC(2026, 9, 7) - daysAgo * 86400000).toISOString();
  return {
    id,
    status: 'active',
    moderation_status: 'approved',
    title_original: title,
    city,
    state,
    location_raw: `${city}, ${state}`,
    job_lat: 39,
    job_lng: -95,
    date_posted: posted,
    first_seen_at: posted,
    ai_analysis: { product_categories: [industry] },
    geographic_eligibility: { kind: 'local' },
  };
}

test('national preview caps identical generalized roles so bootstrap cards stay varied', () => {
  const pool = [
    ...Array.from({ length: 12 }, (_, i) =>
      job(`tm-${i}`, 'Territory Manager', ['Denver', 'Chicago', 'Boston', 'Orlando', 'Atlanta', 'Seattle'][i % 6],
        ['CO', 'IL', 'MA', 'FL', 'GA', 'WA'][i % 6], 'Medical Device', i)),
    job('vet-1', 'Veterinary Sales Representative', 'Austin', 'TX', 'Veterinary', 1),
    job('pharma-1', 'Pharmaceutical Account Manager', 'Nashville', 'TN', 'Pharmaceutical', 2),
    job('diag-1', 'Diagnostics Account Executive', 'Raleigh', 'NC', 'Diagnostics', 3),
    job('dental-1', 'Dental Sales Representative', 'Tampa', 'FL', 'Dental', 4),
    job('spec-1', 'Medical Device Sales Specialist', 'Phoenix', 'AZ', 'Medical Device', 5),
    job('mgr-1', 'Regional Sales Manager', 'Dallas', 'TX', 'Medical Device', 6),
  ];
  const selected = diversifyNationalPreview(pool, 9);
  assert.equal(selected.length, 9);
  const roles = selected.map(generalizedRole);
  const counts = roles.reduce((map, role) => map.set(role, (map.get(role) || 0) + 1), new Map());
  assert.ok((counts.get('Medical Device Territory Manager') || 0) <= 3,
    `Territory Manager should stay capped while alternatives remain: ${JSON.stringify([...counts])}`);
  assert.ok(counts.size >= 4, `expected multiple role types, got ${[...counts.keys()].join(', ')}`);
  assert.ok(roles.includes('Veterinary Sales Representative'));
  assert.ok(roles.some((role) => /Pharmaceutical|Diagnostics|Dental|Sales Specialist|Sales Manager/i.test(role)));
  // Every distinct alternative role in the pool should appear before repeats pile up.
  for (const id of ['vet-1', 'pharma-1', 'diag-1', 'dental-1', 'spec-1', 'mgr-1']) {
    assert.ok(selected.some((job) => job.id === id), `missing diversified job ${id}`);
  }
});

test('national preview still fills the limit when inventory is homogeneous', () => {
  const pool = Array.from({ length: 40 }, (_, i) =>
    job(`same-${i}`, 'Territory Manager', 'Denver', 'CO', 'Medical Device', i));
  const selected = diversifyNationalPreview(pool, 30);
  assert.equal(selected.length, 30);
});
