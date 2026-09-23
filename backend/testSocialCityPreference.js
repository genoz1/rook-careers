const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cityLocations, rankForCityVariety, RECENT_SELECTIONS } = require('./socialCityPreference');
const { selectTopCandidate } = require('./socialPublishWorker');
const { computeJobFingerprintForJob, computeEmployerSpacingKey } = require('./socialAutomation');
const data = require('./data/social-top100-cities-2025.json');
const secret = 'test-only';
const config = {spacingSecret: secret, freshnessWindowDays: 3, brandedTerms: []};
const job = (id, location, employer = id) => ({id, employer_id: employer, source_job_id: id,
  title_original: 'Territory Sales Manager', location_raw: location, company_name: 'Acme Diagnostics',
  state: 'GA', job_lat: 33.75, job_lng: -84.39, status: 'active', moderation_status: 'approved', social_eligible: true,
  last_seen_at: new Date().toISOString(), experience_min_years: 3, employment_type: 'Full-Time', remote_status: 'field',
  compensation_text: '$90,000 - $120,000', ai_analysis: {required_industries: ['Medical Device']}});
const key = j => computeEmployerSpacingKey(j.employer_id, secret);
const rank = (jobs, opts = {}) => rankForCityVariety(jobs, {employerKey: key, ...opts});

test('versioned Census data has exactly 100 unique cities, descending populations, and boundary rank', () => {
  assert.equal(data.cities.length, 100);
  assert.equal(new Set(data.cities.map(c => `${c.city}|${c.state}`)).size, 100);
  assert.equal(data.cities[0].city, 'New York');
  assert.equal(data.cities[99].city, 'Huntsville');
  for (const [i, c] of data.cities.entries()) {
    assert.equal(c.rank, i + 1);
    if (i) assert(data.cities[i - 1].population >= c.population);
    assert(cityLocations({location_raw: `${c.city}, ${c.state}`}).some(l => l.top100), c.city);
  }
});

test('city/state identity, aliases, multiple locations, and remote scope are conservative', () => {
  assert(cityLocations({location_raw: 'St. Louis, Missouri, United States'})[0].top100);
  assert(cityLocations({location_raw: 'US - CA - San Francisco'})[0].top100);
  assert(cityLocations({location_raw: 'Ft. Worth, TX (Hybrid)'})[0].top100);
  assert(cityLocations({location_raw: 'New York City, NY'})[0].top100);
  assert.equal(cityLocations({location_raw: 'Portland, ME'})[0].top100, false);
  assert.equal(cityLocations({location_raw: 'Kansas City, KS'})[0].top100, false);
  assert.equal(cityLocations({location_raw: 'North Las Vegas, NV'}).length, 1);
  assert.equal(cityLocations({location_raw: 'North Las Vegas, NV'})[0].city, 'north las vegas');
  assert.equal(cityLocations({location_raw: 'Remote', city: 'Chicago', state: 'IL'}).length, 0);
  assert.equal(cityLocations({location_raw: 'Chicago metro area, IL'}).length, 0);
  assert.equal(cityLocations({location_raw: 'Dallas, TX | Austin, TX'}).length, 2);
});

test('Top 100 is a preference, with no Top 200 gate or population-rank bias', () => {
  const small = job('small', 'Ocala, FL'), city = job('city', 'Boston, MA');
  assert.equal(rank([small, city])[0].id, 'city');
  assert.deepEqual(rank([small]).map(j => j.id), ['small']);
  assert.equal(rank([job('boston', 'Boston, MA'), job('ny', 'New York, NY')])[0].id, 'boston');
});

test('unused jobs and recent employer/city variety outweigh population preference', () => {
  const used = job('used', 'Boston, MA', 'repeat'), sameCity = job('same-city', 'Boston, MA', 'new'),
    sameEmployer = job('same-employer', 'Seattle, WA', 'repeat'), fallback = job('fallback', 'Ocala, FL', 'other');
  const opts = {recentHistory: [{job_id: used.id, employer_spacing_key: key(used)}], historyJobs: new Map([[used.id, used]])};
  assert.equal(rank([sameCity, sameEmployer, fallback], opts)[0].id, 'fallback');
  assert.equal(rank([used, fallback], {previouslyFeaturedJobIds: new Set(['used'])})[0].id, 'fallback');
  assert.equal(rank([sameEmployer], opts)[0].id, 'same-employer'); // soft cooldown, not empty output
});

test('equal city-preference candidates rotate geography and employer cooldown expires', () => {
  const prior = job('prior', 'San Francisco, CA', 'repeat');
  const rows = [{job_id: prior.id, employer_spacing_key: key(prior)}];
  const opts = {recentHistory: rows, historyJobs: new Map([[prior.id, prior]])};
  assert.equal(rank([job('la', 'Los Angeles, CA'), job('boston', 'Boston, MA')], opts)[0].id, 'boston');
  const old = [...Array.from({length: RECENT_SELECTIONS}, (_, i) => ({job_id: `other-${i}`, employer_spacing_key: 'other'})), ...rows];
  assert.equal(rank([job('repeat', 'Boston, MA', 'repeat'), job('other', 'Seattle, WA')], {...opts, recentHistory: old})[0].id, 'repeat');
});

function mockDb(jobs, history = [], failHistory = false) {
  const calls = [];
  return {calls, from(table) {
    const filters = [], orders = []; let start = 0, end = Infinity;
    const q = {
      select() { return q; },
      eq(k,v) { filters.push(r => r[k] === v); return q; },
      gte(k,v) { filters.push(r => r[k] >= v); return q; },
      in(k,vs) { filters.push(r => vs.includes(r[k])); return q; },
      order(k, o = {}) { orders.push([k,o.ascending !== false]); return q; },
      range(a,b) { start=a; end=b; calls.push({table,start,end}); return q; },
      then(resolve) {
        if (table === 'social_post_history' && failHistory) return resolve({data:null,error:{message:'unavailable'}});
        let rows = [...(table === 'jobs' ? jobs : table === 'social_post_history' ? history : [])].filter(r => filters.every(f => f(r)));
        rows.sort((a,b) => {for(const [k,asc] of orders) {const d=String(a[k]).localeCompare(String(b[k]));if(d)return asc?d:-d;}return 0;});
        return resolve({data:rows.slice(start,end+1),error:null});
      },
    };
    return q;
  }};
}

test('worker considers cities beyond first page and falls back when all cities are ineligible', async () => {
  const jobs = Array.from({length: 510}, (_,i) => job(`a${String(i).padStart(4,'0')}`, 'Ocala, FL'));
  jobs.push(job('zzcity', 'Boston, MA'));
  // Equal timestamps make the ID order deterministic across pagination.
  for(const j of jobs) j.last_seen_at = jobs[0].last_seen_at;
  const db = mockDb(jobs);
  assert.equal((await selectTopCandidate(db, config)).topJob.id, 'zzcity');
  assert(db.calls.some(c => c.table === 'jobs' && c.start === 500));
  jobs.at(-1).status = 'closed';
  assert((await selectTopCandidate(mockDb(jobs), config)).topJob.id.startsWith('a'));
  jobs.at(-1).status='active'; jobs.at(-1).location_raw='Toronto, Canada';
  assert((await selectTopCandidate(mockDb(jobs), config)).topJob.id.startsWith('a'));
});

test('worker derives city variety from successful history, including closed jobs, and fails closed on read errors', async () => {
  const prior=job('prior','Boston, MA','prior-employer'); prior.status='closed';
  const city=job('city','Boston, MA'), fallback=job('fallback','Ocala, FL');
  const history=[{run_key:'prior-AM',job_id:prior.id,job_fingerprint:computeJobFingerprintForJob(prior,secret),
    employer_spacing_key:key(prior),scheduled_for:new Date().toISOString(),facebook_status:'sent',linkedin_status:'sent'}];
  assert.equal((await selectTopCandidate(mockDb([prior,city,fallback],history),config)).topJob.id,'fallback');
  await assert.rejects(selectTopCandidate(mockDb([city],[],true),config),/posting history/);
});
