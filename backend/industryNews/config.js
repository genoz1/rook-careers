'use strict';

function enabled(value) {
  return String(value || '').toLowerCase() === 'true';
}

function getFlags(env = process.env) {
  return Object.freeze({
    industryNews: enabled(env.INDUSTRY_NEWS_ENABLED),
    rssPolling: enabled(env.INDUSTRY_NEWS_RSS_POLLING_ENABLED),
    aiGeneration: enabled(env.INDUSTRY_NEWS_AI_GENERATION_ENABLED),
    automaticPublication: enabled(env.INDUSTRY_NEWS_AUTOMATIC_PUBLICATION_ENABLED),
    socialDistribution: enabled(env.INDUSTRY_NEWS_SOCIAL_DISTRIBUTION_ENABLED),
  });
}

function discoveryEnabled(env = process.env) {
  const flags = getFlags(env);
  return flags.industryNews && flags.rssPolling;
}

function integerSetting(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function getFreshnessHours(env = process.env) {
  return integerSetting(env.INDUSTRY_NEWS_FRESHNESS_HOURS, 72, 6, 168, 'INDUSTRY_NEWS_FRESHNESS_HOURS');
}

function getPublicationLimit(env = process.env) {
  return integerSetting(env.INDUSTRY_NEWS_MAX_PUBLICATIONS_PER_RUN, 2, 1, 20, 'INDUSTRY_NEWS_MAX_PUBLICATIONS_PER_RUN');
}

module.exports = { enabled, getFlags, discoveryEnabled, integerSetting, getFreshnessHours, getPublicationLimit };
