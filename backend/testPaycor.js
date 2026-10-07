const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseBoard, parseDetail, fetchPaycorJobs, normalizePaycorJob } = require('./adapters/paycor');

const clientId = '8a7883d08145828d0181914c5b7a2fa1';
const board = `
  <div class="gnewtonCareerGroupJobTitleClass"><a href="/career/JobIntroduction.action?clientId=${clientId}&id=sales-east">Sales Account Manager, South Carolina</a></div>
  <div class="gnewtonCareerGroupJobTitleClass"><a href="/career/JobIntroduction.action?clientId=${clientId}&id=sales-west">Sales Account Manager, Northern California</a></div>
  <div class="gnewtonCareerGroupJobTitleClass"><a href="/career/JobIntroduction.action?clientId=${clientId}&id=engineer">Software Engineer</a></div>`;

function detail(title, location) {
  return `<table id="gnewtonJobDescription"><tr><td id="gnewtonJobPosition"><b>Position:</b>${title}</td></tr><tr><td id="gnewtonJobLocationInfo">${location}</td></tr><tr><td id="gnewtonJobDescriptionText"><p>${title} owns a sales territory, develops customer relationships, presents veterinary products, and consistently achieves revenue goals.</p><p>Responsibilities include account planning, product demonstrations, pipeline management, and travel throughout the region.</p></td></tr></table>`;
}

test('Paycor board parser binds postings to the verified client identifier', () => {
  const rows = parseBoard(board, clientId);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.id), ['sales-east', 'sales-west', 'engineer']);
});

test('Paycor adapter extracts relevant details and marks normalized jobs verified', async () => {
  const httpFetch = async (url) => {
    const value = String(url);
    const body = value.includes('CareerHome.action') ? board
      : value.includes('sales-east') ? detail('Sales Account Manager, South Carolina', 'Field Based, Charleston, SC')
        : detail('Sales Account Manager, Northern California', 'Remote, CA');
    return { ok: true, status: 200, text: async () => body };
  };
  const jobs = await fetchPaycorJobs(clientId, { httpFetch });
  assert.equal(jobs.sourceListingCount, 3);
  assert.equal(jobs.sourceRelevantCount, 2);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.incompleteSnapshot, false);
  const normalized = normalizePaycorJob(jobs[0], { id: 'zomedica', company_name: 'Zomedica', industry: 'animal health' });
  assert.equal(normalized.source_verified, true);
  assert.equal(normalized.status, 'active');
  assert.match(normalized.title_original, /Sales Account Manager/);
  assert.match(normalized.location_raw, /Charleston/);
});

test('Paycor detail failure produces a partial snapshot instead of a false complete snapshot', async () => {
  const jobs = await fetchPaycorJobs(clientId, { httpFetch: async (url) => {
    if (String(url).includes('CareerHome.action')) return { ok: true, status: 200, text: async () => board };
    return { ok: false, status: 503, text: async () => '' };
  } });
  assert.equal(jobs.length, 0);
  assert.equal(jobs.incompleteSnapshot, true);
  assert.equal(jobs.snapshotWarnings.length, 2);
});
