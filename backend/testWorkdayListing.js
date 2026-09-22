const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fetchWorkdayJobs } = require('./adapters/workday');

test('Workday ignores placeholder listings while preserving valid jobs', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.endsWith('/jobs')) {
      assert.equal(JSON.parse(options.body).offset, 0);
      return { ok: true, json: async () => ({ total: 2, jobPostings: [
        { bulletFields: ['unknown'] },
        { externalPath: '/job/one', title: 'Territory Sales Manager' },
      ] }) };
    }
    assert.ok(url.endsWith('/job/one'));
    return { ok: true, json: async () => ({ jobPostingInfo: { jobDescription: 'Sales role' } }) };
  };
  try {
    const jobs = await fetchWorkdayJobs('example|wd1|Careers');
    assert.equal(jobs.length, 1);
    assert.equal(jobs.incompleteSnapshot, true);
    assert.equal(jobs[0].externalPath, '/job/one');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Workday preserves the verified part of a board after a later detail is blocked', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.endsWith('/jobs')) return { ok: true, json: async () => ({ total: 2, jobPostings: [
      { externalPath: '/job/one', title: 'Sales Representative' },
      { externalPath: '/job/two', title: 'Sales Representative' },
    ] }) };
    if (url.endsWith('/job/two')) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ jobPostingInfo: { jobDescription: 'Sales role' } }) };
  };
  try {
    const jobs = await fetchWorkdayJobs('example|wd1|Careers');
    assert.deepEqual(jobs.map(j => j.externalPath), ['/job/one']);
    assert.equal(jobs.incompleteSnapshot, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Workday marks a short final page incomplete so ingest preserves old jobs', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.endsWith('/jobs')) {
      const offset = JSON.parse(options.body).offset;
      return { ok: true, json: async () => ({ total: 3, jobPostings: offset ? [] : [
        { externalPath: '/job/one', title: 'Sales Representative' },
        { externalPath: '/job/two', title: 'Sales Representative' },
      ] }) };
    }
    return { ok: true, json: async () => ({ jobPostingInfo: { jobDescription: 'Sales role' } }) };
  };
  try {
    const jobs = await fetchWorkdayJobs('example|wd1|Careers');
    assert.equal(jobs.length, 2);
    assert.equal(jobs.incompleteSnapshot, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Workday tolerates a small overlap between listing pages', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url.endsWith('/jobs')) {
      const offset = JSON.parse(options.body).offset;
      const paths = offset === 0 ? ['/job/one', '/job/two'] : ['/job/two', '/job/three'];
      return { ok: true, json: async () => ({ total: 4, jobPostings: paths.map(externalPath => ({ externalPath, title: 'Sales Representative' })) }) };
    }
    return { ok: true, json: async () => ({ jobPostingInfo: { jobDescription: 'Sales role' } }) };
  };
  try {
    const jobs = await fetchWorkdayJobs('example|wd1|Careers');
    assert.deepEqual(jobs.map(j => j.externalPath), ['/job/one', '/job/two', '/job/three']);
    assert.equal(jobs.incompleteSnapshot, true);
  } finally {
    global.fetch = originalFetch;
  }
});
