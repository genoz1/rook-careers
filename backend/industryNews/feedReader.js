'use strict';

const { cleanText } = require('./normalize');

const MAX_FEED_BYTES = 2 * 1024 * 1024;

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}

function blocks(xml, tag) {
  const escaped = escapePattern(tag);
  return [...xml.matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'gi'))].map(match => match[1]);
}

function firstText(block, tags) {
  for (const tag of tags) {
    const escaped = escapePattern(tag);
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'));
    if (match) return cleanText(decodeXml(match[1]));
  }
  return '';
}

function firstRawText(block, tags) {
  for (const tag of tags) {
    const escaped = escapePattern(tag);
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'i'));
    if (match) return decodeXml(match[1]);
  }
  return '';
}

function firstAttribute(block, tags, attribute) {
  for (const tag of tags) {
    const escaped = escapePattern(tag);
    const match = block.match(new RegExp(`<${escaped}\\b([^>]*)>`, 'i'));
    const value = match?.[1].match(new RegExp(`\\b${escapePattern(attribute)}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
    if (value) return decodeXml(value);
  }
  return '';
}

function embeddedImage(block) {
  const media = firstAttribute(block, ['media:content', 'media:thumbnail', 'enclosure'], 'url');
  if (media) return media;
  const html = firstRawText(block, ['content:encoded', 'description', 'content']);
  return html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
}

function linkHref(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?\s*>/gi)];
  const alternate = links.find(match => /\brel\s*=\s*["']alternate["']/i.test(match[1])) || links[0];
  return decodeXml(alternate?.[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '');
}

function rssItem(block) {
  const sourcePublisher = firstText(block, ['source']);
  const creator = firstText(block, ['dc:creator', 'author']);
  return {
    guid: firstText(block, ['guid']), title: firstText(block, ['title']), url: firstText(block, ['link']),
    summary: firstText(block, ['content:encoded', 'description', 'content']),
    publishedAt: firstText(block, ['pubDate', 'dc:date', 'published']), updatedAt: firstText(block, ['updated']),
    sourcePublisher, creator, originalPublisher: sourcePublisher || creator, imageUrl: embeddedImage(block),
  };
}

function atomEntry(block) {
  const sourcePublisher = firstText(block, ['source']);
  const creator = firstText(block, ['name']);
  return {
    guid: firstText(block, ['id']), title: firstText(block, ['title']), url: linkHref(block),
    summary: firstText(block, ['content', 'summary']), publishedAt: firstText(block, ['published']),
    updatedAt: firstText(block, ['updated']), sourcePublisher, creator,
    originalPublisher: sourcePublisher || creator,
    imageUrl: embeddedImage(block),
  };
}

function parseFeedXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('Feed response was empty');
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error('Feed response exceeded size limit');
  const rss = blocks(xml, 'item').map(rssItem);
  const atom = blocks(xml, 'entry').map(atomEntry);
  const items = rss.length ? rss : atom;
  if (!items.length) throw new Error('Feed contained no RSS items or Atom entries');
  return items;
}

async function fetchFeed(source, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (source.status !== 'active' || !source.feedUrl) throw new Error(`Source ${source.id} is not active or lacks a validated feed URL`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.feedUrl, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`);
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > MAX_FEED_BYTES) throw new Error('Feed response exceeded size limit');
    return parseFeedXml(await response.text());
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Feed request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeeds(sources, options = {}) {
  const outcomes = [];
  for (const source of sources.filter(item => item.status === 'active')) {
    try {
      outcomes.push({ source, ok: true, items: await fetchFeed(source, options) });
    } catch (error) {
      outcomes.push({ source, ok: false, items: [], error: error.message });
    }
  }
  return outcomes;
}

module.exports = { MAX_FEED_BYTES, parseFeedXml, fetchFeed, fetchFeeds };
