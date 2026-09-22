const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zipcodes = require('zipcodes');
const { deterministicJobAnalysis } = require('./deterministicJobAnalysis');
const { classify, matches } = require('../public/rook-job-classification');
const { industryPrefilter } = require('./industryPrefilter');
const { resolveLocation, classifyLocation } = require('./jobLocationScope');
const { validateJobLocation } = require('./validateJobLocation');
const { prepareJob } = require('./v7Location');
const { distanceMiles } = require('./geocoding');
const { matchesState, territories } = require('../public/rook-territory-location');

const localGeocode = async query => {
  const match = String(query).match(/^(.+), ([A-Z]{2})$/);
  const place = match && zipcodes.lookupByName(match[1], match[2])[0];
  return place ? { lat: place.latitude, lng: place.longitude, state: place.state } : null;
};
const baseJob = (title, location_raw, description_text = '') => ({
  id: title, title_original: title, location_raw, description_text,
  location_evidence: { source_country_code: 'US' }, status: 'active', moderation_status: 'approved',
});

test('real conflicting ATS locations use explicit title territory first', async () => {
  const cases = [
    ['Teva Memphis', 'Neuroscience Sales Specialist - Memphis, TN', 'Memphis, North Carolina, United States', ['TN'], 'Memphis, TN'],
    ['AstraZeneca Salt Lake City', 'Senior Primary Care Sales Specialist, Salt Lake City, UT', 'US - Iowa City - IA', ['UT'], 'Salt Lake City, UT'],
    ['BD San Francisco/Bay Area', 'Territory Manager - San Francisco, CA/Bay Area', 'USA AZ - Tempe Headquarters', ['CA'], 'San Francisco, CA'],
    ['Elekta OH/MI/IN', 'Account Manager (Ohio, Michigan & Indiana)', 'Georgia - Home Based', ['IN','MI','OH'], null],
    ['Stryker Alexandria', 'Clinical Specialist, Joint Replacement - Alexandria, LA', 'Shreveport, Louisiana', ['LA'], 'Alexandria, LA'],
  ];
  for (const [name,title,raw,states,point] of cases) {
    const result = await resolveLocation(baseJob(title, raw), localGeocode);
    assert.equal(result.location_evidence.selected_location_source, 'explicit_title_territory', name);
    assert.deepEqual([...result.location_evidence.scope.states].sort(), [...states].sort(), name);
    assert.equal(result.location_evidence.locations?.[0]?.location || null, point, name);
    if (!point) assert.equal(result.job_lat, null, name);
  }
});

test('explicit description territories override HQ/remote while preserving scope and provenance', async () => {
  const hq = await resolveLocation(baseJob('Territory Account Manager','Cambridge, MA','This role is remote. Territory includes Miami, Fort Lauderdale, and West Palm Beach, Florida.'), localGeocode);
  assert.deepEqual(hq.location_evidence.locations.map(p=>p.location), ['Miami, FL','Fort Lauderdale, FL','West Palm Beach, FL']);
  assert.equal(hq.location_evidence.selected_location_source, 'explicit_description_territory');
  assert.equal(hq.location_evidence.source_description_hash.length, 32);

  const remote = await resolveLocation(baseJob('Regional Sales Manager','Remote, US','Assigned territory includes Florida, Georgia, and South Carolina.'), localGeocode);
  assert.equal(remote.location_evidence.scope.kind, 'territory');
  assert.deepEqual(remote.location_evidence.scope.states, ['FL','GA','SC']);
  assert.equal(remote.job_lat, null);
  assert(matchesState({...baseJob('Regional Sales Manager','Remote, US'),...remote},'GA'));

  const national = await resolveLocation(baseJob('National Account Manager','Boston, MA','This is a national United States territory.'), localGeocode);
  assert.equal(national.location_evidence.scope.kind, 'national_us');
  assert.equal(national.job_lat, null);
  assert.equal(national.job_lng, null);
});

test('weak geographic mentions do not override ATS location and changed descriptions invalidate cached territory', async () => {
  const job=baseJob('Territory Account Manager','Boston, MA','Our headquarters are in Miami, FL. California experience preferred. Travel to New York may be needed.');
  assert.equal(classifyLocation(job).queries[0].query,'Boston, MA');
  const first=await validateJobLocation({...job,description_text:'Assigned territory includes Florida and Georgia.'},localGeocode);
  assert.deepEqual(first.location_evidence.scope.states,['FL','GA']);
  const changed=await validateJobLocation({...job,description_text:'Assigned territory includes Ohio and Indiana.'},localGeocode,{...first,title_original:job.title_original,location_raw:job.location_raw,description_text:'Assigned territory includes Florida and Georgia.'});
  assert.deepEqual(changed.location_evidence.scope.states,['IN','OH']);

  const oldHq=await resolveLocation({...job,description_text:''},localGeocode);
  const newlyAssigned=await validateJobLocation({...job,description_text:'Assigned territory includes Texas and Oklahoma.'},localGeocode,{...job,...oldHq});
  assert.deepEqual(newlyAssigned.location_evidence.scope.states,['OK','TX']);
  assert.equal(newlyAssigned.job_lat,null);
});

test('location evidence drives state eligibility, nearest-point ranking and radius filtering', async () => {
  const resolved=await resolveLocation(baseJob('Territory Account Manager','Cambridge, MA','Territory includes Miami, Fort Lauderdale, and West Palm Beach, Florida.'),localGeocode);
  const job={...baseJob('Territory Account Manager','Cambridge, MA'),...resolved,ai_analysis:{product_categories:['Diagnostics']}};
  const miami=zipcodes.lookupByName('Miami','FL')[0];
  const profile={home_state:'FL',home_lat:miami.latitude,home_lng:miami.longitude,territory_size_preferences:['local'],desired_industries:['Diagnostics'],total_sales_years:5};
  const prepared=prepareJob(job,profile);
  assert(prepared);
  assert.equal(prepared.state,'FL');
  assert(distanceMiles(profile.home_lat,profile.home_lng,prepared.job_lat,prepared.job_lng)<10);
  const exactRadius=distanceMiles(profile.home_lat,profile.home_lng,prepared.job_lat,prepared.job_lng);
  assert(exactRadius<=100); // same coordinates used by Job Search's finite-radius filter
  assert.equal(prepareJob(job,{...profile,home_state:'WA',home_lat:47.6,home_lng:-122.3}),null);
  assert.deepEqual(territories({...job,location_evidence:{...job.location_evidence,scope:{kind:'territory',states:['FL','GA']}}})[0].states,['FL','GA']);
});

test('deterministic industry evidence covers real examples and every canonical category', () => {
  const examples = [
    ['MWI Animal Health — Territory Manager, Animal Health',{title:'Territory Manager - Animal Health - Madison/Milwaukee'},['Veterinary']],
    ['Antech — Diagnostic Sales Manager',{title:'Diagnostic Sales Manager (Milwaukee)'},['Diagnostics']],
    ['Lexington Medical — Sales Associate, Medical Device',{title:'Sales Associate - Medical Device'},['Medical Device']],
    ['Axsome — Specialty Account Manager',{title:'Specialty Account Manager, Long Term Care',employerIndustry:'Pharmaceutical'},['Pharmaceutical']],
    ['Trupanion — Territory Sales Partner',{title:'Territory Sales Partner - Fort Myers, FL',employerIndustry:'Animal Health'},['Veterinary']],
    ['Intuitive Surgical — Clinical Sales Associate',{title:'Clinical Sales Associate - Macon, GA',employerIndustry:'Medical Device'},['Medical Device']],
    ['Veterinary diagnostics',{title:'Veterinary Diagnostic Sales Manager'},['Diagnostics','Veterinary']],
    ['Veterinary pharmaceuticals',{title:'Animal Health Pharmaceutical Sales Representative'},['Pharmaceutical','Veterinary']],
    ['Human laboratory',{title:'Laboratory Sales Representative'},['Diagnostics']],
    ['Capital device',{title:'Medical Device Capital Equipment Sales Manager'},['Capital Equipment','Medical Device']],
    ['Healthcare SaaS',{title:'Healthcare SaaS Account Executive'},['Healthcare SaaS']],
    ['Dental',{title:'Dental Sales Representative'},['Dental']],
    ['Distribution',{title:'Healthcare Distribution Account Executive'},['Distribution']],
    ['Life sciences',{title:'Biotech Life Sciences Business Development Manager'},['Biotech/Life Sciences']],
  ];
  for(const [name,input,expected] of examples){
    const analysis=deterministicJobAnalysis(input); assert(analysis,name);
    assert.deepEqual([...classify({ai_analysis:analysis}).labels].sort(),[...expected].sort(),name);
  }
  const ambiguous=deterministicJobAnalysis({title:'Strategic Account Executive'});
  assert.equal(classify({ai_analysis:ambiguous}).status,'unresolved');
});

test('background, boilerplate, company name and incidental customer text cannot assign industry', () => {
  const analysis=deterministicJobAnalysis({
    title:'Strategic Account Executive', companyName:'Example Medical Device Corporation',
    description:'Five years of medical device sales experience preferred. Our headquarters contain a diagnostics laboratory. We are an equal opportunity pharmaceutical employer. Customers may include hospitals.',
  });
  assert.deepEqual(classify({ai_analysis:analysis}).labels,[]);
  assert.deepEqual(analysis.required_customer_types,[]);
});

test('industry evidence survives SQL prefilter and shared Dashboard/Job Search filters', () => {
  const route=fs.readFileSync(require.resolve('./routes/jobs'),'utf8');
  const dashboardSection=route.slice(route.indexOf('// GET /api/jobs?'),route.indexOf('// POST /api/jobs/'));
  const searchSection=route.slice(route.indexOf('router.get("/job-search"'),route.indexOf('// GET /api/jobs?'));
  assert.match(dashboardSection,/industryPrefilter\(selection\)/);
  assert.match(dashboardSection,/filter\(industryPass\)/);
  assert.match(searchSection,/industryPrefilter\(selection\)/);
  assert.match(searchSection,/filter\(industryPass\)/);

  for(const label of ['Diagnostics','Veterinary','Medical Device','Capital Equipment','Pharmaceutical','Healthcare SaaS','Dental','Distribution','Biotech/Life Sciences']){
    const title=label==='Distribution'?'Healthcare Distribution Sales Representative':`${label} Sales Representative`;
    const analysis=deterministicJobAnalysis({title});
    const job={ai_analysis:analysis};
    assert(matches(job,[label]),label);
    const sql=industryPrefilter([label]);
    assert(sql && analysis.product_categories.some(value=>sql.split(',').some(clause=>value.toLowerCase().includes(clause.split('%')[1]))),label);
  }
});
