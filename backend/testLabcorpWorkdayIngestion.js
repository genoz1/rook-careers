const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  fetchWorkdayJobs,
  normalizeWorkdayJob,
  workdayTitleLooksRelevant,
} = require('./adapters/workday');
const { validateJobLocation } = require('./validateJobLocation');
const { isUsEligibleJob } = require('./jobEligibility');

const LABCORP = 'labcorp|wd1|External';
const TARGET_TITLES = [
  'Specialty Development Executive - Southeast Florida',
  'Specialty Development Executive, Rare Disease - North Florida',
  'Oncology Development Specialty, Jacksonville, FL',
];

test('Labcorp Workday admits the three verified sales titles rejected by the generic title filter', () => {
  for (const title of TARGET_TITLES) assert.equal(workdayTitleLooksRelevant(title, LABCORP), true, title);
  for (const title of TARGET_TITLES) assert.equal(workdayTitleLooksRelevant(title, 'another-employer|wd1|External'), false, title);
});

test('Labcorp Workday pagination continues past the former 1,000-result boundary', async () => {
  const originalFetch = global.fetch;
  const offsets = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/jobs')) {
      const { offset, limit } = JSON.parse(options.body);
      offsets.push(offset);
      const total = 1021;
      const count = Math.max(0, Math.min(limit, total - offset));
      return { ok: true, json: async () => ({
        total,
        jobPostings: Array.from({ length: count }, (_, i) => {
          const id = offset + i;
          return {
            title: id === 1000 ? TARGET_TITLES[0] : 'Phlebotomist',
            externalPath: `/job/${id}`,
            bulletFields: [String(id)],
          };
        }),
      }) };
    }
    assert.ok(String(url).endsWith('/job/1000'));
    return { ok: true, json: async () => ({ jobPostingInfo: { jobReqId: '1000', jobDescription: 'Outside sales.' } }) };
  };
  try {
    const jobs = await fetchWorkdayJobs(LABCORP);
    assert.equal(offsets.at(-1), 1020);
    assert.equal(offsets.length, 52);
    assert.deepEqual(jobs.map(job => job.externalPath), ['/job/1000']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Labcorp North Florida multi-location detail keeps all four cities and remains US-eligible', async () => {
  const job = normalizeWorkdayJob({
    title: TARGET_TITLES[1],
    externalPath: '/job/Orlando-FL/Specialty-Development-Executive--Rare-Disease---North-Florida_2633451',
    detail: { jobPostingInfo: {
      jobReqId: '2633451',
      jobDescription: 'Outside sales role.',
      location: 'Orlando FL',
      additionalLocations: ['Pensacola FL', 'Jacksonville FL', 'Tampa FL'],
      jobRequisitionLocation: { country: { alpha2Code: 'US' } },
    } },
  }, { ats_identifier: LABCORP, id: 'labcorp-id', company_name: 'Labcorp' });

  const seen = [];
  const resolved = await validateJobLocation(job, async query => {
    seen.push(query);
    const cities = {
      'Orlando, FL': { lat: 28.5383, lng: -81.3792, state: 'FL' },
      'Pensacola, FL': { lat: 30.4213, lng: -87.2169, state: 'FL' },
      'Jacksonville, FL': { lat: 30.3322, lng: -81.6557, state: 'FL' },
      'Tampa, FL': { lat: 27.9506, lng: -82.4572, state: 'FL' },
    };
    return cities[query];
  });
  Object.assign(job, resolved);

  assert.equal(job.source_job_id, '2633451');
  assert.deepEqual(seen, ['Orlando, FL', 'Pensacola, FL', 'Jacksonville, FL', 'Tampa, FL']);
  assert.equal(job.location_evidence.status, 'validated');
  assert.equal(job.location_evidence.locations.length, 4);
  assert.equal(job.state, 'FL');
  assert.equal(isUsEligibleJob(job), true);
});
