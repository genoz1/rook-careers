'use strict';

const crypto = require('crypto');
const { generateStructuredText } = require('../resources/aiText');
const { slugify } = require('../resources/catalog');

const ARTICLE_SCHEMA = { name: 'rook_industry_news_article', schema: {
  type: 'object', additionalProperties: false,
  properties: {
    title: { type: 'string' }, description: { type: 'string' }, body_html: { type: 'string' },
    image_alt: { type: 'string' },
    social_copy: { type: 'object', additionalProperties: false, properties: {
      facebook: { type: 'string' }, instagram: { type: 'string' },
    }, required: ['facebook', 'instagram'] },
  }, required: ['title', 'description', 'body_html', 'image_alt', 'social_copy'],
} };

const REVIEW_SCHEMA = { name: 'rook_industry_news_review', schema: {
  type: 'object', additionalProperties: false,
  properties: { approved: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['approved', 'reason'],
} };

function evidenceFor(event) {
  return (event.items || []).map(item => ({
    headline: item.title, summary: item.summary || '', publisher: item.originalPublisher || item.sourceName || 'Original publisher',
    url: item.canonicalUrl, published_at: item.publishedAt,
  })).filter(item => item.headline && item.url);
}

function words(html) { return String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean); }
function numbers(value) { return [...String(value || '').matchAll(/\b\d[\d,.%$-]*\b/g)].map(match => match[0].replace(/[,$%]/g, '')); }
function validateArticle(article, event) {
  if (!article || typeof article !== 'object') throw new Error('Article generation returned no structured result');
  if (!article.title || article.title.length < 20 || article.title.length > 110) throw new Error('Article title length failed editorial validation');
  if (!article.description || article.description.length < 70 || article.description.length > 180) throw new Error('Article description length failed editorial validation');
  if (!/^(?:<(?:p|h2|h3|ul|ol|li|strong|em)>|<\/(?:p|h2|h3|ul|ol|li|strong|em)>|[^<>])*$/i.test(article.body_html || '')) throw new Error('Article HTML contains an unsupported element or attribute');
  const count = words(article.body_html).length;
  if (count < 250 || count > 1000 || ((article.body_html || '').match(/<h2>/gi) || []).length < 2) throw new Error('Article body failed length or structure validation');
  if (/[“”"]/.test(article.body_html)) throw new Error('Article body contains unverified quotation marks');
  if (/\b(?:todo|lorem ipsum|as an ai|source \d+)\b/i.test(article.body_html)) throw new Error('Article body contains an editorial artifact');
  const evidence = JSON.stringify(evidenceFor(event));
  const grounded = new Set(numbers(evidence));
  const ungrounded = numbers(`${article.title} ${article.description} ${article.body_html}`).filter(number => !grounded.has(number));
  if (ungrounded.length) throw new Error(`Article contains ungrounded numeric claims: ${[...new Set(ungrounded)].join(', ')}`);
  for (const channel of ['facebook', 'instagram']) {
    const copy = article.social_copy?.[channel] || '';
    if (copy.length < 30 || copy.length > 1200 || /https?:\/\//i.test(copy)) throw new Error(`${channel} social copy failed validation`);
  }
  return { ...article, word_count: count, body_hash: crypto.createHash('sha256').update(article.body_html).digest('hex') };
}

async function generateArticle(event, deps = {}) {
  const evidence = evidenceFor(event);
  if (!evidence.length) throw new Error('Eligible event has no attributable source evidence');
  const generator = deps.generate || generateStructuredText;
  const article = await generator(
    'You are ROOK Careers editorial. Write an original, concise, event-centered industry news brief for medical and veterinary sales professionals. Use only the supplied RSS evidence. Never invent, infer, predict, quote, or add a number not present in the evidence. Attribute claims to the named publishers. Do not mention job openings. Return simple HTML using only p, h2, h3, ul, ol, li, strong, and em, with no attributes or links.',
    JSON.stringify({ category: event.category, event_type: event.eventType, evidence }), ARTICLE_SCHEMA, 1800,
  );
  const checked = validateArticle(article, event);
  const reviewer = deps.review || generateStructuredText;
  const review = await reviewer(
    'Act as a strict factual editor. Approve only if every factual and numeric claim is supported by the supplied evidence, attribution is clear, the copy is original rather than copied, and no prediction or job claim is made.',
    JSON.stringify({ evidence, article: checked }), REVIEW_SCHEMA, 300,
  );
  if (!review?.approved) throw new Error(`Editorial review rejected article: ${review?.reason || 'unspecified reason'}`);
  const suffix = crypto.createHash('sha256').update(String(event.id || event.clusterKey)).digest('hex').slice(0, 8);
  return { ...checked, slug: `${slugify(checked.title).slice(0, 90)}-${suffix}`, sources: evidence,
    category: event.category, event_type: event.eventType, event_id: event.id };
}

module.exports = { ARTICLE_SCHEMA, REVIEW_SCHEMA, evidenceFor, validateArticle, generateArticle };
