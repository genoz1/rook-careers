'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { index, article, adminReport } = require('../views');
const { CATEGORIES, BUCKETS, APPROVED_FEEDS, getSources } = require('../catalog');
const { redirectNewsRoot } = require('../routes');
const { redirectLegacyIndustryNews } = require('../../resources/routes');

test('news root redirects only the slashless URL and lets the canonical index render', () => {
  let redirect = null;
  let nextCalls = 0;
  const res = { redirect: (status, location) => { redirect = { status, location }; } };
  redirectNewsRoot({ path: '/news' }, res, () => { nextCalls += 1; });
  assert.deepEqual(redirect, { status: 301, location: '/news/' });
  redirect = null;
  redirectNewsRoot({ path: '/news/' }, res, () => { nextCalls += 1; });
  assert.equal(redirect, null);
  assert.equal(nextCalls, 1);
});

test('public news index is indexable and renders only supplied published articles', () => {
  const html = index([{slug:'approved-device',title:'Approved device reaches the market',description:'A commercially relevant medical device development.',category:CATEGORIES[0].slug,published_at:'2026-10-02'}]);
  assert.doesNotMatch(html, /noindex/i);
  assert.match(html, /Approved device reaches the market/);
  assert.match(html, /<article/i);
  assert.match(html, /ROOK INDUSTRY NEWS/);
  assert.match(html, /Stay current on the companies, products, approvals and industry moves shaping medical sales\./);
  assert.match(html, /href="\/news\/approved-device\/"/);
  assert.match(html, /src="\/news\/approved-device\/social\.jpg"/);
  assert.equal((html.match(/class="category-card/g) || []).length, 8);
  assert.match(html, /M&amp;A \/ Funding \/ Partnerships/);
  assert.doesNotMatch(html, />Dental</);
  assert.doesNotMatch(html, />Product Launches</);
  assert.match(html, /aria-current="page" href="\/news\/">Industry News/);
  assert.match(html, /href="\/resources\/">Resources/);
  assert.match(index([], 'medical-device'), /rel="canonical" href="https:\/\/rookcareers\.com\/news\/medical-device\/"/);
});

test('public news article uses the Resources shell while preserving NewsArticle metadata and attribution', () => {
  const item = {
    slug: 'approved-device', title: 'Approved device reaches the market',
    description: 'A commercially relevant medical device development.', category: 'medical-device',
    published_at: '2026-10-02T12:00:00Z', updated_at: '2026-10-02T13:00:00Z',
    body_html: '<h2>What changed</h2><p>The product was approved.</p>', image_alt: 'Approved device product illustration',
    sources: [{ publisher: 'FDA', url: 'https://www.fda.gov/example', published_at: '2026-10-02T10:00:00Z' }],
  };
  const html = article(item, [{ ...item, slug: 'related-story', title: 'Related development' }]);
  assert.match(html, /<link rel="stylesheet" href="\/resources\.css">/);
  assert.match(html, /class="logo"/);
  assert.match(html, /class="container article-layout news-article-layout"/);
  assert.match(html, /"@type":"NewsArticle"/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /"name":"ROOK Industry News"/);
  assert.match(html, /alt="Approved device product illustration"/);
  assert.match(html, /rel="canonical" href="https:\/\/rookcareers\.com\/news\/approved-device\/"/);
  assert.match(html, /href="https:\/\/www\.fda\.gov\/example"/);
  assert.match(html, /By ROOK Industry News/);
  assert.match(html, /Looking for your next/);
  assert.match(html, /Related Industry News/);
});

test('legacy Resources Industry News hub permanently redirects to canonical News', () => {
  let redirect = null;
  redirectLegacyIndustryNews({}, { redirect: (status, location) => { redirect = { status, location }; } });
  assert.deepEqual(redirect, { status: 301, location: '/news/' });
});

test('homepage and shared mobile menu link Industry News to the canonical hub', () => {
  const publicDir = path.resolve(__dirname, '../../../public');
  for (const file of ['index.html', 'rook-mobile-menu.html']) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    assert.match(html, /href="\/news\/">\s*Industry News\s*</);
    assert.doesNotMatch(html, /href="\/resources\/category\/industry-news\/">Industry News</);
  }
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
