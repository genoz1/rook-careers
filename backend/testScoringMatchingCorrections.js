const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scoreJob } = require('./matching');
const { scoreLiveJob, liveScoreOptions } = require('./liveScoring');
const { prepareJob } = require('./v7Location');
const { classifyLocation } = require('./jobLocationScope');
const { classify, matches, VERSION } = require('../public/rook-job-classification');

const orlando = {
  home_lat: 28.54,
  home_lng: -81.38,
  home_state: 'Florida',
  desired_industries: ['Diagnostics'],
  territory_size_preferences: ['local'],
  total_sales_years: 12,
  resume_structured: {
    industries_experience: [{ industry: 'Diagnostics' }],
    product_categories: ['Diagnostics', 'Molecular'],
    customer_types: ['Laboratories', 'Hospitals'],
    seniority_level: 'Territory Manager',
    sales_motion: ['Field', 'hunter'],
    total_sales_years: 12,
  },
};

function localDiag(overrides = {}) {
  return {
    id: 'local-diag',
    title_original: 'Territory Sales Executive, Orlando, FL',
    company_name: 'Cepheid',
    location_raw: 'Orlando, Florida, United States',
    job_lat: 28.54,
    job_lng: -81.38,
    state: 'FL',
    status: 'active',
    moderation_status: 'approved',
    ai_analysis: { product_categories: ['Diagnostics'], required_years_experience: 5 },
    location_evidence: {
      version: 4,
      status: 'validated',
      source_location: 'Orlando, Florida, United States',
      source_title: 'Territory Sales Executive, Orlando, FL',
      locations: [{ lat: 28.54, lng: -81.38, state: 'FL' }],
    },
    ...overrides,
  };
}

test('AI pharmaceutical label cannot override trauma/device title evidence', () => {
  const job = {
    title_original: 'Trauma and Reconstruction Sales Representative - Gainesville',
    company_name: 'Smith & Nephew',
    description_text: 'Sell orthopedic trauma implants and capital equipment to surgeons.',
    ai_analysis: { product_categories: ['Pharmaceutical'] },
  };
  const labels = classify(job).labels;
  assert.ok(labels.includes('Medical Device'), labels);
  assert.equal(labels.includes('Pharmaceutical'), false, labels);
  assert.equal(matches(job, ['Medical Device']), true);
  assert.equal(matches(job, ['Pharmaceutical']), false);
});

test('Latin America title territory is foreign even with a US city geocode', () => {
  const job = {
    title_original: 'Specialty Development Executive - Latin America',
    location_raw: 'Tampa FL | Remote_United States',
    job_lat: 27.95,
    job_lng: -82.46,
    state: 'FL',
    description_text: 'Responsible for the Latin America territory covering Brazil and Mexico.',
  };
  const scope = classifyLocation(job);
  assert.equal(scope.kind, 'foreign');
  assert.equal(prepareJob(job, orlando), null);
});

test('Northeast US title does not score as a Florida local territory', () => {
  const job = localDiag({
    id: 'ne',
    title_original: 'Diagnostics Account Executive - Northeast',
    location_raw: 'Boston, MA',
    job_lat: 42.36,
    job_lng: -71.06,
    state: 'MA',
    location_evidence: {
      version: 4,
      status: 'validated',
      source_location: 'Boston, MA',
      source_title: 'Diagnostics Account Executive - Northeast',
      locations: [{ lat: 42.36, lng: -71.06, state: 'MA' }],
    },
  });
  const scope = classifyLocation(job);
  assert.equal(scope.kind, 'territory');
  assert.ok(scope.states.includes('NY'));
  assert.equal(scope.states.includes('FL'), false);
  assert.equal(prepareJob(job, orlando), null);
});

test('nearby Florida diagnostics outranks distant/unrelated pharmaceutical Latin America', () => {
  const local = prepareJob(localDiag(), orlando);
  const pharmaLatam = {
    id: 'latam-pharma',
    title_original: 'Pharmaceutical Sales Director - Latin America',
    company_name: 'Example Pharma',
    location_raw: 'Miami, FL',
    job_lat: 25.77,
    job_lng: -80.19,
    state: 'FL',
    ai_analysis: { product_categories: ['Pharmaceutical'] },
    description_text: 'Lead Latin America pharmaceutical sales.',
  };
  const localScore = scoreLiveJob(local, orlando, local);
  // Foreign / international roles are excluded from prepareJob for local prefs.
  assert.equal(prepareJob(pharmaLatam, orlando), null);
  assert.ok(localScore.overall_score >= 85);
});

test('smooth local distance differentiates nearby vs farther Florida jobs', () => {
  const near = prepareJob(localDiag({ job_lat: 28.54, job_lng: -81.38 }), orlando);
  const farther = prepareJob(localDiag({
    id: 'tampa',
    title_original: 'Territory Sales Executive, Tampa, FL',
    location_raw: 'Tampa, Florida, United States',
    job_lat: 27.95,
    job_lng: -82.46,
    location_evidence: {
      version: 4,
      status: 'validated',
      source_location: 'Tampa, Florida, United States',
      source_title: 'Territory Sales Executive, Tampa, FL',
      locations: [{ lat: 27.95, lng: -82.46, state: 'FL' }],
    },
  }), orlando);
  const nearScore = scoreLiveJob(near, orlando, near);
  const farScore = scoreLiveJob(farther, orlando, farther);
  assert.ok(nearScore.preference_fit > farScore.preference_fit, `${nearScore.preference_fit} vs ${farScore.preference_fit}`);
  assert.ok(nearScore.overall_score >= farScore.overall_score);
});

test('remote/national verified roles keep geography options without local mileage', () => {
  const remote = {
    id: 'remote',
    title_original: 'Diagnostics Solutions Executive (USA, REMOTE)',
    company_name: 'Beckman Coulter',
    location_raw: 'USA - Remote',
    job_lat: null,
    job_lng: null,
    ai_analysis: { product_categories: ['Diagnostics'] },
    location_evidence: {
      version: 4,
      status: 'validated',
      source_location: 'USA - Remote',
      source_title: 'Diagnostics Solutions Executive (USA, REMOTE)',
      scope: { kind: 'remote_us' },
    },
  };
  const prepared = prepareJob(remote, { ...orlando, territory_size_preferences: ['remote', 'local'] });
  assert.equal(prepared.geographic_eligibility.kind, 'remote_us');
  const score = scoreLiveJob(prepared, { ...orlando, territory_size_preferences: ['remote', 'local'] }, prepared);
  assert.ok(score.overall_score != null);
  assert.ok(!(score.reasons || []).join(' ').match(/miles from you/i));
});

test('no-résumé users still get differentiated rankings below 100', () => {
  const noResume = { ...orlando, resume_structured: null };
  const near = prepareJob(localDiag(), noResume);
  const inside = prepareJob(localDiag({
    id: 'inside',
    title_original: 'Inside Sales Representative - Diagnostics',
    employment_type: 'inside',
  }), noResume);
  const nearScore = scoreLiveJob(near, noResume, near);
  const insideScore = scoreLiveJob(inside, noResume, inside);
  assert.ok(nearScore.overall_score < 100);
  assert.ok(insideScore.overall_score < nearScore.overall_score);
});

test('literal 100% requires an excellent match, not preference-only proximity', () => {
  const noResume = { ...orlando, resume_structured: null };
  const prepared = prepareJob(localDiag(), noResume);
  const score = scoreLiveJob(prepared, noResume, prepared);
  assert.ok(score.overall_score <= 99);
  assert.equal(score.excellent_match, false);
});

test('live scoring helper always enables V7 options', () => {
  const prepared = prepareJob(localDiag(), orlando);
  const opts = liveScoreOptions(prepared);
  assert.equal(opts.smoothLocalDistance, true);
  assert.equal(opts.canonicalVeterinaryEvidence, true);
  assert.equal(opts.geography.kind, 'local');
  const withOpts = scoreJob(prepared, orlando, opts);
  const viaHelper = scoreLiveJob(prepared, orlando, prepared);
  assert.deepEqual(viaHelper.overall_score, withOpts.overall_score);
});

test('jobs route wires scoreLiveJob on home/explore/recruiter paths', () => {
  const source = fs.readFileSync(path.join(__dirname, 'routes', 'jobs.js'), 'utf8');
  assert.match(source, /scoreLiveJob/);
  assert.match(source, /prepareJob\(job, exploredProfile\)/);
  assert.match(source, /prepareJob\(job, anonymousProfile\)/);
  // Home live path must not call bare scoreJob(job, profile) anymore.
  assert.equal(/_liveMatch:\s*scoreJob\(job,\s*profile\)/.test(source), false);
});

test('classifier version advanced for reconciled industry evidence', () => {
  assert.equal(VERSION, 2);
});
