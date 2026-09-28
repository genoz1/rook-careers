const assert = require('node:assert/strict');
const { fetchPreviewReports } = require('./previewReporting');

(async () => {
  const clients = {
    meta: { fetchCampaignPerformance: async period => [{ period, clicks: 3 }] },
    google: { fetchCampaignPerformance: async () => { throw new Error('Google unavailable'); } },
    reddit: { fetchCampaignPerformance: () => new Promise(() => {}) },
  };
  const results = await fetchPreviewReports(['meta', 'google', 'reddit'], clients, 10);
  assert.deepEqual(results[0], { platform:'meta', campaigns:[{ period:'yesterday', clicks:3 }] });
  assert.match(results[1].error, /Google unavailable/);
  assert.match(results[2].error, /exceeded/);
  assert.equal(results.length, 3);
  console.log('Ad Manager preview reporting tests passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
