'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateArticle, generateArticle } = require('../content');
const { tick } = require('../publication');
const { MemoryNewsStore } = require('../store');
const views = require('../views');
const { captionFor } = require('../social');

const paragraph = '<p>' + Array(270).fill('market').join(' ') + '</p>';
const event = { id: 'event-1', clusterKey: 'one', category: 'medical-device', eventType: 'final-regulatory-approval', items: [{ title: 'Company receives FDA approval for cardiac device', summary: 'The company received FDA approval for its cardiac device.', originalPublisher: 'Publisher One', canonicalUrl: 'https://example.com/story', publishedAt: '2026-10-02T12:00:00Z' }] };
const generated = { title: 'Company receives FDA approval for cardiac device', description: 'A newly approved cardiac device marks a commercially relevant development for the medical device market.', body_html: `<h2>What happened</h2>${paragraph}<h2>Commercial context</h2><p>The approval may shape conversations across the device market.</p>`, image_alt: 'Abstract medical device industry news graphic', social_copy: { facebook: 'A new cardiac device approval is shaping the medical device market.', instagram: 'A new cardiac device approval is shaping the medical device market.' } };

test('article validation blocks unsupported numbers and accepts grounded structured copy', () => {
  assert.equal(validateArticle(generated, event).word_count > 250, true);
  assert.throws(() => validateArticle({ ...generated, body_html: generated.body_html + '<p>Revenue rose 42 percent.</p>' }, event), /ungrounded numeric/);
});

test('generation preserves deterministic source attribution and passes separate review', async () => {
  let calls = 0;
  let generationPrompt = '';
  const article = await generateArticle(event, { generate: async prompt => { calls += 1; generationPrompt = prompt; return generated; }, review: async () => ({ approved: true, reason: 'grounded' }) });
  assert.equal(calls, 1); assert.equal(article.sources[0].publisher, 'Publisher One'); assert.match(article.slug, /-[a-f0-9]{8}$/);
  assert.match(generationPrompt, /description must be 70-180 characters/i);
  assert.match(generationPrompt, /body_html must be 300-700 words/i);
  assert.match(generationPrompt, /at least two h2 section headings/i);
});

test('publication is capped, idempotent, and verifies before distribution', async () => {
  const store = new MemoryNewsStore(); store.events = [event, { ...event, id: 'event-2', clusterKey: 'two' }, { ...event, id: 'event-3', clusterKey: 'three' }];
  const result = await tick({ allowFixtureRun: true, env: { INDUSTRY_NEWS_MAX_PUBLICATIONS_PER_RUN: '2' }, store, generateArticle: async e => ({ ...generated, slug: `story-${e.id}`, sources: event.items, category: e.category, event_type: e.eventType, event_id: e.id, word_count: 275, body_hash: e.id }), verifyPublic: async () => true });
  assert.equal(result.published.length, 2); assert.equal(store.articles.length, 2); assert.equal(store.articles.every(a => a.public_verified_at), true);
  const secondWorker = await tick({ allowFixtureRun: true, env: { INDUSTRY_NEWS_MAX_PUBLICATIONS_PER_RUN: '2' }, store, generateArticle: async e => ({ ...generated, slug: `story-${e.id}`, sources: event.items, category: e.category, event_type: e.eventType, event_id: e.id, word_count: 275, body_hash: e.id }), verifyPublic: async () => true });
  assert.equal(secondWorker.published.length, 0); assert.equal(store.articles.length, 2);
});

test('exact slug is renderable for verification before discovery surfaces expose it', async () => {
  const store = new MemoryNewsStore();
  store.events = [{ ...event, leaseOwner: 'verification-owner' }];
  const saved = await store.finishGeneration('event-1', 'verification-owner', {
    ...generated, slug: 'verification-pending', sources: event.items,
    category: event.category, event_type: event.eventType, event_id: event.id,
  });

  assert.equal(saved.public_verified_at, null);
  assert.equal((await store.articleBySlug(saved.slug)).slug, saved.slug);
  assert.deepEqual(await store.listArticles(), []);
  assert.equal((await store.queuedDistributions()).length, 0);

  await store.markPublicVerified(saved.slug);
  assert.equal((await store.listArticles()).length, 1);
  assert.equal((await store.queuedDistributions()).length, 2);
});

test('public article HTML includes SEO, sources, CTA, and noindex is absent', () => {
  const html = views.article({ ...generated, slug: 'story', category: 'medical-device', sources: [{ publisher: 'Publisher One', url: 'https://example.com/story', published_at: '2026-10-02' }], published_at: '2026-10-02', updated_at: '2026-10-02' });
  assert.match(html, /NewsArticle/); assert.match(html, /Publisher One/); assert.match(html, /rook-onboarding-v8\.html/); assert.doesNotMatch(html, /noindex/);
});

test('social payload uses exact news URL and existing UTM convention', () => {
  const caption=captionFor({slug:'approved-device',social_copy:{facebook:'Market update.',instagram:'Market update.'}},'facebook');
  assert.match(caption,/\/news\/approved-device\//); assert.match(caption,/utm_source=facebook/); assert.match(caption,/utm_content=industry_news/);
});
