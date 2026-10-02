'use strict';

const { createHash } = require('node:crypto');

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|mc_cid|mc_eid|ref|referral)$/i;

const PUBLISHER_DOMAINS = Object.freeze({
  'medicalxpress.com': 'Medical Xpress', 'stocktitan.net': 'Stock Titan', 'globenewswire.com': 'GlobeNewswire',
  'medicaldevice-network.com': 'Medical Device Network', 'sggp.org.vn': 'SGGP', 'mk.co.kr': 'Maeil Business Newspaper',
  'news-medical.net': 'News-Medical', 'tradingview.com': 'TradingView', 'prnewswire.com': 'PR Newswire',
  'dealroom.co': 'Dealroom.co', 'yahoo.com': 'Yahoo News', 'mpo-mag.com': 'Medical Product Outsourcing',
  'investingnews.com': 'Investing News Network', 'fool.com': 'The Motley Fool', 'massdevice.com': 'MassDevice',
  'wnem.com': 'WNEM', 'techbriefs.com': 'Tech Briefs', 'medtechdive.com': 'MedTech Dive',
  'chemistryworld.com': 'Chemistry World', 'dvm360.com': 'dvm360', 'investors.com': "Investor's Business Daily",
  'investing.com': 'Investing.com', 'medcitynews.com': 'MedCity News', 'livemint.com': 'Mint',
  'business-standard.com': 'Business Standard', 'expresshealthcare.in': 'Express Healthcare',
  'healthcareasiamagazine.com': 'Healthcare Asia', 'newswire.com': 'Newswire',
  'fiercehealthcare.com': 'Fierce Healthcare',
});

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeGuid(value, canonicalUrl) {
  const guid = cleanText(value);
  return guid || canonicalUrl || null;
}

function registrableHost(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return Object.keys(PUBLISHER_DOMAINS).find(domain => host === domain || host.endsWith(`.${domain}`)) || host;
  } catch {
    return null;
  }
}

function publisherFromUrl(value) {
  const host = registrableHost(value);
  if (!host) return null;
  if (PUBLISHER_DOMAINS[host]) return PUBLISHER_DOMAINS[host];
  const label = host.split('.')[0].replace(/[-_]+/g, ' ').trim();
  return label ? label.replace(/\b\w/g, character => character.toUpperCase()) : null;
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeItem(raw, source, now = new Date()) {
  const canonicalUrl = canonicalizeUrl(raw.url || raw.link);
  const guid = normalizeGuid(raw.guid || raw.id, canonicalUrl);
  const title = cleanText(raw.title);
  const summary = cleanText(raw.summary || raw.description || raw.contentSnippet || raw.content);
  const suppliedPublisher = cleanText(raw.sourcePublisher) || null;
  const suppliedCreator = cleanText(raw.creator || raw.author || raw.originalPublisher) || null;
  const originalPublisher = suppliedPublisher || publisherFromUrl(canonicalUrl) || suppliedCreator;
  const authorByline = suppliedCreator && suppliedCreator.toLowerCase() !== String(originalPublisher || '').toLowerCase()
    ? suppliedCreator : null;
  if (!guid || !title) throw new Error('Feed item requires a stable GUID/URL and title');
  const seenAt = now.toISOString();
  return {
    sourceId: source.id,
    discoverySourceIds: [source.id],
    sourceName: originalPublisher || source.name,
    feedBucket: source.name,
    feedBuckets: [source.name],
    logicalBucket: source.logicalBucket || null,
    aggregatorPublisher: source.publisher,
    originalPublisher,
    authorByline,
    authorityTier: source.authorityTier,
    sourceKind: source.kind,
    sourceCategories: [...source.categories],
    guid,
    canonicalUrl,
    imageUrl: canonicalizeUrl(raw.imageUrl || raw.image || raw.enclosureUrl),
    title,
    summary,
    publishedAt: isoDate(raw.publishedAt || raw.pubDate || raw.published),
    updatedAt: isoDate(raw.updatedAt || raw.updated),
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    retrievalHash: hash([title, summary, canonicalUrl].join('\n')),
  };
}

module.exports = {
  TRACKING_PARAM, PUBLISHER_DOMAINS, cleanText, canonicalizeUrl, isoDate, normalizeGuid,
  registrableHost, publisherFromUrl, normalizeItem, hash,
};
