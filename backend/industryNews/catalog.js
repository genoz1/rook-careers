'use strict';

const CATEGORIES = Object.freeze([
  ['medical-device', 'Medical Device / MedTech'],
  ['diagnostics-laboratory', 'Diagnostics / Laboratory'],
  ['pharmaceutical-biotech', 'Pharmaceutical / Biotech'],
  ['veterinary-animal-health', 'Veterinary / Animal Health'],
  ['dental', 'Dental'],
  ['healthcare-technology', 'Healthcare Technology'],
  ['fda-regulatory', 'FDA / Regulatory'],
  ['ma-funding', 'M&A / Funding'],
  ['product-launches', 'Product Launches'],
  ['commercial-sales', 'Commercial / Sales Leadership'],
].map(([slug, label]) => Object.freeze({ slug, label })));

// Logical areas describe discovery intent only. Individual RSS.app feeds may
// overlap these areas; content classification remains item-driven.
const BUCKETS = Object.freeze([
  ['medtech', 'Medical Device / MedTech'], ['diagnostics', 'Diagnostics / Laboratory'],
  ['pharma-biotech', 'Pharmaceutical / Biotech'], ['veterinary', 'Veterinary / Animal Health'],
  ['healthcare-tech', 'Healthcare Technology'], ['regulatory', 'FDA / Regulatory / Product Approvals'],
  ['deals', 'M&A / Funding / Partnerships'], ['commercial', 'Commercial / Sales / Leadership'],
].map(([id, name]) => Object.freeze({ id, name })));

const APPROVED_FEEDS = Object.freeze([
  ['rss-app-medtech', 'Medical Device / MedTech — Broad', 'medtech', 'INDUSTRY_NEWS_RSS_APP_MEDTECH_FEED_URL', 'https://rss.app/feeds/t8vBIf9iikM4hkgv.xml', ['medical-device', 'dental', 'product-launches']],
  ['rss-app-diagnostics', 'Diagnostics / Laboratory — Broad', 'diagnostics', 'INDUSTRY_NEWS_RSS_APP_DIAGNOSTICS_FEED_URL', 'https://rss.app/feeds/tLSDdMjiTzmKBxLQ.xml', ['diagnostics-laboratory', 'dental', 'product-launches']],
  ['rss-app-pharma-biotech', 'Pharmaceutical / Biotech — Broad', 'pharma-biotech', 'INDUSTRY_NEWS_RSS_APP_PHARMA_BIOTECH_FEED_URL', 'https://rss.app/feeds/tJ8bVOnKW4CcJq88.xml', ['pharmaceutical-biotech', 'product-launches']],
  ['rss-app-veterinary', 'Veterinary / Animal Health — Broad', 'veterinary', 'INDUSTRY_NEWS_RSS_APP_VETERINARY_FEED_URL', 'https://rss.app/feeds/tRcYd5Ls6iTr6jiG.xml', ['veterinary-animal-health', 'pharmaceutical-biotech', 'product-launches']],
  ['rss-app-healthcare-tech', 'Healthcare Technology / Software — Broad', 'healthcare-tech', 'INDUSTRY_NEWS_RSS_APP_HEALTHCARE_TECH_FEED_URL', 'https://rss.app/feeds/t7IOZ1MHuWcJQzRM.xml', ['healthcare-technology', 'product-launches']],
  ['rss-app-regulatory', 'FDA / Regulatory / Product Approvals — Broad', 'regulatory', 'INDUSTRY_NEWS_RSS_APP_REGULATORY_FEED_URL', 'https://rss.app/feeds/tDnLHWoxE4b6LfhZ.xml', ['fda-regulatory', 'medical-device', 'diagnostics-laboratory', 'pharmaceutical-biotech', 'veterinary-animal-health', 'product-launches']],
  ['rss-app-fierce-biotech-deals', 'Fierce Biotech — Deals', 'deals', 'INDUSTRY_NEWS_RSS_APP_FIERCE_BIOTECH_DEALS_FEED_URL', 'https://rss.app/feeds/TyxT6RYZ9hS1FluT.xml', ['ma-funding', 'pharmaceutical-biotech']],
  ['rss-app-medtech-dive-ma', 'MedTech Dive — M&A', 'deals', 'INDUSTRY_NEWS_RSS_APP_MEDTECH_DIVE_MA_FEED_URL', 'https://rss.app/feeds/XqsAsrNHEFpKoM9D.xml', ['ma-funding', 'medical-device', 'diagnostics-laboratory']],
  ['rss-app-dvm360-business', 'dvm360 — Business / Animal Health', 'commercial', 'INDUSTRY_NEWS_RSS_APP_DVM360_BUSINESS_FEED_URL', 'https://rss.app/feeds/8tnzBxoBt4bzova7.xml', ['veterinary-animal-health', 'commercial-sales', 'ma-funding']],
  ['rss-app-medtech-dive-main', 'MedTech Dive — Main News', 'medtech', 'INDUSTRY_NEWS_RSS_APP_MEDTECH_DIVE_MAIN_FEED_URL', 'https://rss.app/feeds/TlyJoVkJBvK1FopD.xml', ['medical-device', 'diagnostics-laboratory', 'fda-regulatory', 'ma-funding', 'product-launches']],
  ['rss-app-cafepharma', 'Cafepharma Updates', 'commercial', 'INDUSTRY_NEWS_RSS_APP_CAFEPHARMA_FEED_URL', 'https://rss.app/feeds/pkbOgL69QQyUFzrR.xml', ['pharmaceutical-biotech', 'medical-device', 'diagnostics-laboratory', 'fda-regulatory', 'ma-funding', 'commercial-sales']],
].map(([id, name, logicalBucket, envKey, approvedFeedUrl, categories]) => Object.freeze({
  id, name, logicalBucket, envKey, approvedFeedUrl, categories: Object.freeze(categories),
  automationPolicy: id === 'rss-app-cafepharma' ? 'lead-only' : 'normal',
})));

function rssAppUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || !(url.hostname === 'rss.app' || url.hostname.endsWith('.rss.app'))) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function getSources(env = process.env) {
  return APPROVED_FEEDS.map(feed => {
    const configured = Object.prototype.hasOwnProperty.call(env, feed.envKey) ? env[feed.envKey] : feed.approvedFeedUrl;
    const feedUrl = rssAppUrl(configured);
    return Object.freeze({
      id: feed.id,
      name: feed.name,
      feedUrl,
      publisher: 'RSS.app',
      categories: [...feed.categories],
      authorityTier: 3,
      kind: 'aggregator',
      status: feedUrl ? 'active' : 'disabled',
      requiresFeedValidation: false,
      configKey: feed.envKey,
      logicalBucket: feed.logicalBucket,
      automationPolicy: feed.automationPolicy,
    });
  });
}

const SOURCES = Object.freeze(getSources());

function category(slug) {
  return CATEGORIES.find(item => item.slug === slug) || null;
}

module.exports = { CATEGORIES, BUCKETS, APPROVED_FEEDS, SOURCES, rssAppUrl, getSources, category };
