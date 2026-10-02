'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeedXml, fetchFeed, fetchFeeds } = require('../feedReader');

const fixture = name => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
const source = (id, feedUrl = `https://${id}.test/rss`) => ({ id, name: id, feedUrl, status: 'active' });

test('parses RSS and Atom fixtures into the common shape', () => {
  const rss = parseFeedXml(fixture('sample-rss.xml'));
  const atom = parseFeedXml(fixture('sample-atom.xml'));
  assert.equal(rss.length, 3);
  assert.equal(rss[0].guid, 'device-recall-001');
  assert.match(rss[0].summary, /medical device manufacturer/);
  assert.equal(atom.length, 1);
  assert.equal(atom[0].url, 'https://publisher.test/stryker-example-medical');
  assert.equal(atom[0].updatedAt, '2026-09-16T13:00:00Z');
});

test('parses RSS.app-style original publisher and image provenance', () => {
  const items = parseFeedXml(fixture('rss-app-medtech.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].guid, 'rss-app-medtech-001');
  assert.equal(items[0].originalPublisher, 'MedTech Dive');
  assert.equal(items[0].url, 'https://www.medtechdive.test/news/stryker-example-medical/?utm_source=rss.app');
  assert.equal(items[0].imageUrl, 'https://images.medtechdive.test/stryker.jpg?utm_source=rss.app');
  assert.equal(items[1].originalPublisher, 'MassDevice');
  assert.equal(items[1].imageUrl, 'https://images.massdevice.test/robot.jpg');
});

test('rejects empty or entry-free XML', () => {
  assert.throws(() => parseFeedXml(''), /empty/);
  assert.throws(() => parseFeedXml(fixture('malformed.xml')), /no RSS items or Atom entries/);
});

test('isolates one feed failure and continues with other sources', async () => {
  const fetchImpl = async url => {
    if (url.includes('broken')) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => fixture('sample-atom.xml') };
  };
  const outcomes = await fetchFeeds([source('broken'), source('working')], { fetchImpl });
  assert.deepEqual(outcomes.map(row => row.ok), [false, true]);
  assert.match(outcomes[0].error, /HTTP 503/);
  assert.equal(outcomes[1].items.length, 1);
});

test('aborts a feed request at the configured timeout', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(fetchFeed(source('slow'), { fetchImpl, timeoutMs: 5 }), /timed out after 5ms/);
});
