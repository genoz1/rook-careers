'use strict';

const crypto = require('crypto');
const { getFlags, getFreshnessHours, getPublicationLimit } = require('./config');
const { generateArticle } = require('./content');
const { origin } = require('../resources/catalog');

async function verifyPublic(article, deps = {}) {
  const response = await (deps.fetchImpl || fetch)(`${origin()}/news/${article.slug}/`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok || !(await response.text()).includes(article.title)) throw new Error('Published Industry News page could not be verified');
  return true;
}

async function tick(deps = {}) {
  const env = deps.env || process.env;
  const flags = getFlags(env);
  if (!deps.allowFixtureRun && !(flags.industryNews && flags.aiGeneration && flags.automaticPublication)) return { state: 'disabled', published: [] };
  if (!deps.store) throw new Error('Industry News publication requires an injected store');
  const owner = crypto.randomUUID();
  const published = [];
  const publicationLimit = getPublicationLimit(env);
  for (let index = 0; index < publicationLimit; index += 1) {
    const eventId = await deps.store.claimGenerationEvent(owner, getFreshnessHours(env), publicationLimit);
    if (!eventId) break;
    try {
      const event = await deps.store.loadEvent(eventId);
      const article = await (deps.generateArticle || generateArticle)(event, deps);
      const saved = await deps.store.finishGeneration(eventId, owner, article);
      await (deps.verifyPublic || verifyPublic)(saved, deps);
      await deps.store.markPublicVerified(saved.slug);
      published.push(saved);
    } catch (error) {
      await deps.store.failGeneration(eventId, owner, error.message);
    }
  }
  if (flags.socialDistribution && published.length && deps.social) await deps.social.dispatch({ ...deps, store: deps.store });
  return { state: 'complete', published };
}

module.exports = { verifyPublic, tick };
