'use strict';

const { getFreshnessHours } = require('./config');

const ROUNDUP_TITLE = /\b(?:roundup|wrap[- ]?up|weekly|daily digest|and more updates|more updates|paws and profits|clinic center|up and down the ladder|latest comings and goings)\b/i;
const ROUNDUP_SUMMARY = /\b(?:today['’]s headlines|for more news|here['’]s what mattered)\b/i;

function isRoundup(item) {
  return ROUNDUP_TITLE.test(item.title || '') || ROUNDUP_SUMMARY.test(item.summary || '');
}

function freshness(item, now = new Date(), hours = getFreshnessHours()) {
  const value = item.publishedAt || item.updatedAt;
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return { fresh: false, reason: 'Missing a valid publication timestamp.' };
  const ageMs = now.getTime() - timestamp;
  if (ageMs < -6 * 3600000) return { fresh: false, reason: 'Publication timestamp is implausibly in the future.' };
  if (ageMs > hours * 3600000) return { fresh: false, reason: `Older than the ${hours}-hour automatic-publication window.` };
  return { fresh: true, reason: `Within the ${hours}-hour automatic-publication window.` };
}

function automationEligibility(item, source, now = new Date(), env = process.env) {
  const age = freshness(item, now, getFreshnessHours(env));
  if (source.automationPolicy === 'lead-only') return { eligible: false, fresh: age.fresh, roundup: isRoundup(item), reason: 'Lead-only discovery source.' };
  if (isRoundup(item)) return { eligible: false, fresh: age.fresh, roundup: true, reason: 'Multi-event roundup requires later extraction.' };
  if (item.relevanceStatus !== 'relevant') return { eligible: false, fresh: age.fresh, roundup: false, reason: `${item.relevanceStatus} items never automatically advance.` };
  if (item.eventType === 'unknown') return { eligible: false, fresh: age.fresh, roundup: false, reason: 'Unknown event types never automatically advance.' };
  if (item.eventType === 'regulatory-review-stage') return { eligible: false, fresh: age.fresh, roundup: false, reason: 'Preliminary regulatory stages require editorial review and never automatically advance.' };
  if (!age.fresh) return { eligible: false, fresh: false, roundup: false, reason: age.reason };
  return { eligible: true, fresh: true, roundup: false, reason: 'Relevant, fresh, recognized single event.' };
}

module.exports = { ROUNDUP_TITLE, ROUNDUP_SUMMARY, isRoundup, freshness, automationEligibility };
