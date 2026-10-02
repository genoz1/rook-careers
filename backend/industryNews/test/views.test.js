'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { index, adminReport } = require('../views');
const { CATEGORIES, BUCKETS, APPROVED_FEEDS, getSources } = require('../catalog');

test('public news index is indexable and renders only supplied published articles', () => {
  const html = index([{slug:'approved-device',title:'Approved device reaches the market',description:'A commercially relevant medical device development.',category:CATEGORIES[0].slug,published_at:'2026-10-02'}]);
  assert.doesNotMatch(html, /noindex/i);
  assert.match(html, /Approved device reaches the market/);
  assert.match(html, /<article/i);
});

test('catalog defines eight logical buckets and the eleven approved RSS.app feeds', () => {
  assert.equal(BUCKETS.length, 8);
  assert.equal(APPROVED_FEEDS.length, 11);
  assert.ok(getSources({}).every(source => source.status === 'active' && source.feedUrl?.startsWith('https://rss.app/feeds/')));
});

test('admin report renders candidate evidence and source links', () => {
  const html = adminReport({ generatedAt: '2026-09-18T00:00:00Z', run: { id: 'run-1', status: 'complete', metrics: {} }, candidates: [{
    headline: 'Stryker acquires Example Medical', category: 'medical-device', eventType: 'acquisition-merger',
    sourceNames: ['Source A'], sourceUrls: ['https://source-a.test/story'], supportingFeedItems: 1,
    sources: [{ name: 'Source A', byline: 'Reporter One', url: 'https://source-a.test/story', feedBucket: 'Medical Device / MedTech' }],
    feedBuckets: ['Medical Device / MedTech'],
    earliestPublicationAt: '2026-09-16T00:00:00Z', latestPublicationAt: '2026-09-16T00:00:00Z',
    relevanceStatus: 'relevant', relevanceReason: 'test', hasAuthoritativeEvidence: false, entities: ['Stryker'], products: [],
  }] });
  assert.match(html, /Stryker acquires Example Medical/);
  assert.match(html, /https:\/\/source-a\.test\/story/);
  assert.match(html, /By Reporter One/);
  assert.match(html, /noindex,\s*nofollow/i);
});
