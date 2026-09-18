// Validates real-world custom_html candidates surfaced by the Sept 2026
// research package against the actual extraction path (parseCareersPage /
// fetchCustomHtmlJobs), not just "the page loads in a browser." Kept as
// its own file rather than appended to testCustomHtml.js so the existing,
// already-passing regression suite stays untouched.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fetchCustomHtmlJobs, normalizeCustomHtmlJob } = require('./adapters/customHtml');
const { titleLooksRelevant } = require('./relevanceFilter');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/customHtml', name + '.html'), 'utf8');

// TG Therapeutics: confirmed via WebFetch this session to be a genuinely
// static "no recognized ATS" careers page — a flat list of role-titled
// links to per-job pages, applications by email. This is exactly ROOK's
// differentiator case (a real first-party posting a generic job board
// would never index). The listing fixture below is trimmed to 4 of the
// page's real 17 postings; the detail-page fixtures are reconstructed
// from the same WebFetch structural read, not byte-identical downloads
// (this sandbox cannot reach tgtherapeutics.com directly — see the repo's
// other adapter file headers for the same caveat).
const tgEmployer = {
  id: 'tg-therapeutics',
  company_name: 'TG Therapeutics',
  company_website: 'https://www.tgtherapeutics.com',
  careers_url: 'https://www.tgtherapeutics.com/about-us/join-us/',
  ats_type: 'custom_html',
  industry: 'Pharmaceutical',
};

function tgFetchPage(target) {
  const map = {
    'https://www.tgtherapeutics.com/about-us/join-us/': 'tg-therapeutics',
    'https://www.tgtherapeutics.com/about-us/join-us/careers-106-assoc-sales-rep/': 'tg-therapeutics-detail-sales-rep',
    'https://www.tgtherapeutics.com/about-us/join-us/careers-155-ad-key-accounts-boston/': 'tg-therapeutics-detail-key-accounts',
    'https://www.tgtherapeutics.com/about-us/join-us/careers-161-msl-neurology/': 'tg-therapeutics-detail-msl',
    'https://www.tgtherapeutics.com/about-us/join-us/careers-177-acctmgr-supplychain/': 'tg-therapeutics-detail-accounting',
  };
  const key = map[target];
  if (!key) throw new Error(`Unexpected fetch target in test: ${target}`);
  return Promise.resolve(fixture(key));
}

test('TG Therapeutics: real "no ATS" careers page — distinct job-link tier fetches each posting, MSL correctly excluded downstream by the shared relevance filter (not by customHtml itself)', async () => {
  const jobs = await fetchCustomHtmlJobs(tgEmployer, { fetchPage: tgFetchPage, now: new Date('2026-09-18') });
  assert.equal(jobs.length, 4);

  const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j]));
  assert(byTitle['Associate Sales Representative']);
  assert(byTitle['Assoc. Director, Key Accounts – Boston']);
  assert(byTitle['Medical Science Liaison, Neurology – Midwest']);
  assert(byTitle['Accounting Manager, Supply Chain']);
  for (const j of jobs) assert.equal(j.tier, 'job_link');

  const salesRep = normalizeCustomHtmlJob(byTitle['Associate Sales Representative'], tgEmployer);
  assert.equal(salesRep.status, 'active');
  assert.equal(salesRep.source_verified, true);
  assert.equal(salesRep.application_url, 'mailto:careers@tgtherapeutics.com');
  assert.equal(salesRep.location_raw, 'Remote (US)');

  const keyAccounts = normalizeCustomHtmlJob(byTitle['Assoc. Director, Key Accounts – Boston'], tgEmployer);
  assert.equal(keyAccounts.status, 'active');
  assert.equal(keyAccounts.location_raw, 'Boston, MA');

  // The MSL role is a real, currently-open, correctly-extracted posting —
  // customHtml itself must not drop it. ROOK's separate relevance filter
  // is what keeps it out of what gets shown to sales-focused users, which
  // is the correct layer for that decision, not the extraction adapter.
  const msl = normalizeCustomHtmlJob(byTitle['Medical Science Liaison, Neurology – Midwest'], tgEmployer);
  assert.equal(msl.status, 'active');
  assert.equal(titleLooksRelevant(msl.title_original), false);

  const relevantOnly = jobs.filter((j) => titleLooksRelevant(j.title));
  assert.deepEqual(
    relevantOnly.map((j) => j.title).sort(),
    ['Associate Sales Representative', 'Assoc. Director, Key Accounts – Boston'].sort()
  );
});

// 10x Genomics (Round 2): the stale stored Greenhouse config was found to
// redirect to careers.kula.ai/10xgenomics — a real, static, server-rendered
// job board (confirmed via WebFetch, not JS-only), every posting on the
// SAME host as the listing page. That same-origin property is exactly
// what fetchCustomHtmlJobs's default detail-page fetcher requires — it
// explicitly refuses cross-origin detail links (see Nestlé Purina's
// finding in the prior round's report). No dedicated "Kula" adapter is
// needed if careers_url is pointed at the kula.ai page directly.
const kulaEmployer = {
  id: '10x-genomics',
  company_name: '10x Genomics',
  company_website: 'https://www.10xgenomics.com',
  careers_url: 'https://careers.kula.ai/10xgenomics',
  ats_type: 'custom_html',
  industry: 'Life Sciences',
};

function kulaFetchPage(target) {
  const map = {
    'https://careers.kula.ai/10xgenomics': '10x-genomics-kula',
    'https://careers.kula.ai/10xgenomics/48890/': '10x-genomics-detail-sales-exec',
    'https://careers.kula.ai/10xgenomics/48901/': '10x-genomics-detail-district-sales',
    'https://careers.kula.ai/10xgenomics/48902/': '10x-genomics-detail-account-exec',
    'https://careers.kula.ai/10xgenomics/48910/': '10x-genomics-detail-mech-eng',
  };
  const key = map[target];
  if (!key) throw new Error(`Unexpected fetch target in test: ${target}`);
  return Promise.resolve(fixture(key));
}

test('10x Genomics (careers.kula.ai): same-origin custom_html works without a dedicated Kula adapter — sales roles extracted, territory/remote/HQ locations preserved distinctly, engineering role correctly left to the relevance filter', async () => {
  const jobs = await fetchCustomHtmlJobs(kulaEmployer, { fetchPage: kulaFetchPage, now: new Date('2026-09-18') });
  assert.equal(jobs.length, 4);
  const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j]));

  const salesExec = normalizeCustomHtmlJob(byTitle['Sales Executive (Spatial Technology)'], kulaEmployer);
  assert.equal(salesExec.status, 'active');
  assert.equal(salesExec.source_verified, true);
  assert.equal(salesExec.location_raw, 'Japan');

  const districtSales = normalizeCustomHtmlJob(byTitle['District Sales Manager, BioPharma'], kulaEmployer);
  // A nationwide territory must not be silently swapped for a single HQ
  // city (10x Genomics HQ is Pleasanton, CA — that must not appear here).
  assert.equal(districtSales.location_raw, 'United States');
  assert(!districtSales.location_raw.includes('Pleasanton'));

  const acctExec = normalizeCustomHtmlJob(byTitle['Account Executive, Enterprise Accounts'], kulaEmployer);
  assert.equal(acctExec.location_raw, 'Remote (US)');

  const relevantOnly = jobs.filter((j) => titleLooksRelevant(j.title));
  assert.deepEqual(
    relevantOnly.map((j) => j.title).sort(),
    ['Account Executive, Enterprise Accounts', 'District Sales Manager, BioPharma', 'Sales Executive (Spatial Technology)'].sort()
  );
  assert(!relevantOnly.some((j) => j.title.includes('Mechanical Engineer')));
});

test('10x Genomics: a job link pointing at a different host than the careers page is never treated as a same-site posting — this is exactly what makes the same-origin kula.ai page usable and Nestlé Purina\'s cross-host feed (a different case checked in the prior round) unusable without further work', () => {
  const { parseCareersPage } = require('./adapters/customHtml');
  const offSiteHtml = '<main><h1>Careers</h1><a href="https://jobdetails.example.com/job/1">Territory Sales Manager</a></main>';
  const parsed = parseCareersPage(offSiteHtml, 'https://careers.kula.ai/10xgenomics');
  // The off-host link is neither extracted as a static job nor queued as
  // a detail link to follow — parseCareersPage's own hostname check
  // drops it before any fetch would even be attempted.
  assert.equal(parsed.jobs.length, 0);
  assert.equal(parsed.detailLinks.length, 0);
});
