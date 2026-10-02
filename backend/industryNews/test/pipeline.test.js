'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeedXml } = require('../feedReader');
const { canonicalizeUrl, normalizeItem } = require('../normalize');
const { evaluateRelevance } = require('../relevance');
const { decorate, classifyEventType, clusterItems } = require('../cluster');
const { MemoryNewsStore } = require('../store');
const { runDiscovery, start } = require('../worker');
const { buildCandidateReport } = require('../report');
const { getFlags, discoveryEnabled } = require('../config');
const { APPROVED_FEEDS, getSources } = require('../catalog');

const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
const makeSource = (id, overrides = {}) => ({
  id, name: id, feedUrl: `https://${id}.test/rss`, publisher: id, categories: ['medical-device'],
  authorityTier: 2, kind: 'editorial', status: 'active', requiresFeedValidation: false, ...overrides,
});
const now = new Date('2026-09-18T12:00:00.000Z');

test('all controls are off by default and discovery does not schedule or run', async () => {
  assert.deepEqual(getFlags({}), {
    industryNews: false, rssPolling: false, aiGeneration: false,
    automaticPublication: false, socialDistribution: false,
  });
  assert.equal(discoveryEnabled({ INDUSTRY_NEWS_ENABLED: 'true' }), false);
  assert.equal(start({ env: {} }), false);
  assert.equal((await runDiscovery({ env: {}, store: new MemoryNewsStore() })).state, 'disabled');
});

test('approved RSS.app source URLs are active by default and explicit invalid values fail closed', () => {
  const approved = getSources({});
  assert.equal(approved.length, 11);
  assert.equal(APPROVED_FEEDS.length, 11);
  assert.ok(approved.every(source => source.status === 'active' && source.feedUrl?.startsWith('https://rss.app/feeds/')));
  const configured = getSources({
    INDUSTRY_NEWS_RSS_APP_MEDTECH_FEED_URL: 'https://rss.app/feeds/medtech.xml',
    INDUSTRY_NEWS_RSS_APP_FIERCE_BIOTECH_DEALS_FEED_URL: 'https://example.com/not-rss-app.xml',
  });
  assert.equal(configured.find(source => source.id === 'rss-app-medtech').status, 'active');
  assert.equal(configured.find(source => source.id === 'rss-app-fierce-biotech-deals').status, 'disabled');
  assert.ok(configured.every(source => source.kind === 'aggregator' && source.publisher === 'RSS.app'));
});

test('normalizes URLs, dates, GUID fallback, and retrieval hashes deterministically', () => {
  assert.equal(
    canonicalizeUrl('http://WWW.Example.com//story/?utm_source=rss&b=2&a=1#top'),
    'https://example.com/story?a=1&b=2',
  );
  const source = makeSource('normalizer');
  const item = normalizeItem({ title: '  A <b>Device</b>  ', url: 'https://example.test/a?gclid=x', publishedAt: '2026-09-01' }, source, now);
  assert.equal(item.guid, 'https://example.test/a');
  assert.equal(item.title, 'A Device');
  assert.equal(item.publishedAt, '2026-09-01T00:00:00.000Z');
  assert.match(item.retrievalHash, /^[a-f0-9]{64}$/);
});

test('deduplicates independently by source GUID and canonical URL', async () => {
  const store = new MemoryNewsStore();
  const source = makeSource('dedupe');
  const base = decorate({
    ...normalizeItem({ guid: 'guid-1', url: 'https://example.test/story?utm_source=one', title: 'FDA clears a medical device' }, source, now),
    relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'],
  });
  assert.equal((await store.ingestItem(base)).alreadySeen, false);
  assert.equal((await store.ingestItem({ ...base, canonicalUrl: 'https://example.test/other' })).alreadySeen, true);
  assert.equal((await store.ingestItem({ ...base, guid: 'guid-2' })).alreadySeen, true);
  assert.equal(store.items.length, 1);
});

test('preserves every discovery feed when canonical URL deduplication spans feeds', async () => {
  const store = new MemoryNewsStore();
  const sourceA = makeSource('source-a', { name: 'Feed A' });
  const sourceB = makeSource('source-b', { name: 'Feed B' });
  const first = decorate({
    ...normalizeItem({ guid: 'a-1', url: 'https://publisher.test/shared', title: 'FDA clears a medical device' }, sourceA, now),
    relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'],
  });
  const second = decorate({
    ...normalizeItem({ guid: 'b-1', url: 'https://publisher.test/shared', title: 'FDA clears a medical device' }, sourceB, now),
    relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'],
  });
  await store.ingestItem(first);
  const duplicate = await store.ingestItem(second);
  assert.equal(duplicate.alreadySeen, true);
  assert.deepEqual(new Set(store.items[0].discoverySourceIds), new Set(['source-a', 'source-b']));
  assert.deepEqual(new Set(store.items[0].feedBuckets), new Set(['Feed A', 'Feed B']));
});

test('applies conservative deterministic relevance decisions', () => {
  const source = makeSource('rules');
  const raw = parseFeedXml(fixture('sample-rss.xml'));
  const results = raw.map(item => evaluateRelevance(normalizeItem(item, source, now)));
  assert.equal(results[0].status, 'relevant');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'rejected');
});

test('retains RSS.app bucket and original article provenance through normalization', () => {
  const source = getSources({ INDUSTRY_NEWS_RSS_APP_MEDTECH_FEED_URL: 'https://rss.app/feeds/medtech.xml' })
    .find(candidate => candidate.id === 'rss-app-medtech');
  const raw = parseFeedXml(fixture('rss-app-medtech.xml'))[0];
  const item = normalizeItem(raw, source, now);
  assert.equal(item.feedBucket, 'Medical Device / MedTech — Broad');
  assert.equal(item.aggregatorPublisher, 'RSS.app');
  assert.equal(item.originalPublisher, 'MedTech Dive');
  assert.equal(item.sourceName, 'MedTech Dive');
  assert.equal(item.canonicalUrl, 'https://medtechdive.test/news/stryker-example-medical');
  assert.equal(item.imageUrl, 'https://images.medtechdive.test/stryker.jpg');
});

test('classifies event types and clusters only corroborating versions of an event', () => {
  const sourceA = makeSource('source-a');
  const sourceB = makeSource('source-b');
  const a = decorate({ ...normalizeItem(parseFeedXml(fixture('source-a.xml'))[0], sourceA, now), relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'] });
  const b = decorate({ ...normalizeItem(parseFeedXml(fixture('source-b.xml'))[0], sourceB, now), relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'] });
  const unrelated = decorate({
    ...normalizeItem({ guid: 'c-1', url: 'https://source-c.test/other', title: 'Medtronic launches a new surgical robot', summary: 'A medical device product launch.', publishedAt: '2026-09-17T10:00:00.000Z' }, makeSource('source-c'), now),
    relevanceStatus: 'relevant', relevanceReason: 'test', categories: ['medical-device'],
  });
  assert.equal(classifyEventType(a), 'acquisition-merger');
  const clusters = clusterItems([a, b, unrelated]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find(cluster => cluster.eventType === 'acquisition-merger').items.length, 2);
});

test('clusters the same event across RSS.app buckets while keeping a distinct event separate', () => {
  const sources = getSources({
    INDUSTRY_NEWS_RSS_APP_MEDTECH_FEED_URL: 'https://rss.app/feeds/medtech.xml',
    INDUSTRY_NEWS_RSS_APP_FIERCE_BIOTECH_DEALS_FEED_URL: 'https://rss.app/feeds/deals.xml',
  });
  const medtech = sources.find(source => source.id === 'rss-app-medtech');
  const deals = sources.find(source => source.id === 'rss-app-fierce-biotech-deals');
  const prepared = [
    ...parseFeedXml(fixture('rss-app-medtech.xml')).map(raw => ({ raw, source: medtech })),
    ...parseFeedXml(fixture('rss-app-deals.xml')).map(raw => ({ raw, source: deals })),
  ].map(({ raw, source }) => {
    const item = normalizeItem(raw, source, now);
    const relevance = evaluateRelevance(item);
    return decorate({ ...item, relevanceStatus: relevance.status, relevanceReason: relevance.reason, categories: relevance.categories });
  });
  const clusters = clusterItems(prepared);
  assert.equal(clusters.length, 2);
  const acquisition = clusters.find(cluster => cluster.eventType === 'acquisition-merger');
  assert.equal(acquisition.items.length, 2);
  assert.deepEqual(new Set(acquisition.items.map(item => item.originalPublisher)), new Set(['MedTech Dive', 'Fierce Healthcare']));
  const report = buildCandidateReport({ run: null, events: clusters });
  const candidate = report.candidates.find(row => row.eventType === 'acquisition-merger');
  assert.equal(candidate.sourceCount, 2);
  assert.deepEqual(new Set(candidate.feedBuckets), new Set(['Medical Device / MedTech — Broad', 'Fierce Biotech — Deals']));
});

test('fixture discovery deduplicates items, isolates failures, clusters, and reports candidates', async () => {
  const sourceA = makeSource('source-a');
  const sourceB = makeSource('source-b');
  const failed = makeSource('failed');
  const store = new MemoryNewsStore();
  const fetchFeeds = async () => [
    { source: sourceA, ok: true, items: parseFeedXml(fixture('source-a.xml')) },
    { source: sourceB, ok: true, items: parseFeedXml(fixture('source-b.xml')) },
    { source: failed, ok: false, items: [], error: 'fixture failure' },
  ];
  const first = await runDiscovery({ allowFixtureRun: true, sources: [sourceA, sourceB, failed], fetchFeeds, store, now });
  assert.equal(first.state, 'partial');
  assert.equal(first.metrics.feedsFailed, 1);
  assert.equal(first.metrics.uniqueEventClusters, 1);
  assert.equal(first.metrics.multiSourceClusters, 1);
  const second = await runDiscovery({ allowFixtureRun: true, sources: [sourceA, sourceB, failed], fetchFeeds, store, now });
  assert.equal(second.metrics.alreadySeenEntries, 2);
  assert.equal(store.items.length, 2);
  const report = buildCandidateReport(await store.candidateReport(second.run.id));
  assert.equal(report.candidates.length, 1);
  assert.deepEqual(report.candidates[0].sourceNames.sort(), ['Source A', 'Source B']);
  assert.equal(report.candidates[0].supportingFeedItems, 2);
});

test('discovery stores Review items but clusters only automation-eligible Relevant items', async () => {
  const source = makeSource('eligibility');
  const store = new MemoryNewsStore();
  const fetchFeeds = async () => [{ source, ok: true, items: [
    { guid: 'relevant', url: 'https://example.test/relevant', title: 'FDA clears a medical device', publishedAt: '2026-09-18T10:00:00Z' },
    { guid: 'review', url: 'https://example.test/review', title: 'Medical device industry outlook', publishedAt: '2026-09-18T10:00:00Z' },
  ] }];
  const result = await runDiscovery({ allowFixtureRun: true, sources: [source], fetchFeeds, store, now, env: {} });
  assert.equal(store.items.length, 2);
  assert.equal(store.items.find(item => item.guid === 'review').relevanceStatus, 'review');
  assert.equal(store.items.find(item => item.guid === 'review').automationEligible, false);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].items[0].guid, 'relevant');
});

test('fixture pipeline makes no implicit global network or paid-service call', async () => {
  const originalFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls += 1; throw new Error('unexpected network call'); };
  try {
    const source = makeSource('local-only');
    const store = new MemoryNewsStore();
    await runDiscovery({
      allowFixtureRun: true, sources: [source], store, now,
      fetchFeeds: async () => [{ source, ok: true, items: parseFeedXml(fixture('sample-atom.xml')) }],
    });
    assert.equal(networkCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('discovery remains independent and publication/social are invoked only behind explicit flags', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  assert.doesNotMatch(workerSource, /openai|anthropic|buffer|pushover/i);
  assert.match(workerSource, /flags\.aiGeneration && flags\.automaticPublication/);
});
