'use strict';

const meta = require('../resources/meta');
const { origin } = require('../resources/catalog');

function captionFor(article, channel) {
  const url = new URL(`${origin()}/news/${article.slug}/`);
  url.search = new URLSearchParams({ utm_source: channel, utm_medium: 'social', utm_campaign: 'organic', utm_content: 'industry_news' });
  return `${article.social_copy[channel].replace(/https?:\/\/\S+/gi, '').trim()}\n\n${url}`;
}

async function sendArticle(article, channel, deps = {}) {
  const claimed = await deps.store.claimDistribution(article.slug, channel);
  if (!claimed) return { state: 'already_claimed' };
  try {
    const resolved = await (deps.resolve || meta.resolve)(deps);
    if (resolved.report[channel] !== 'PASS') throw new Error(`${channel} permissions/identity not verified`);
    const c = resolved.config;
    const graph = deps.graph || meta.graph;
    const caption = captionFor(article, channel);
    const imageUrl = `${origin()}/news/${article.slug}/social.jpg`;
    let receipt;
    if (channel === 'facebook') receipt = await graph(`${c.page}/photos`, { url: imageUrl, caption }, 'POST', { config: c });
    else {
      const container = await graph(`${c.ig}/media`, { image_url: imageUrl, caption }, 'POST', { config: c });
      let ready = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const status = await graph(container.id, { fields: 'status_code' }, 'GET', { config: c });
        if (status.status_code === 'FINISHED') { ready = true; break; }
        if (['ERROR', 'EXPIRED'].includes(status.status_code)) break;
        await (deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
      }
      if (!ready) throw new Error('Instagram container not ready; reconcile before retry');
      receipt = await graph(`${c.ig}/media_publish`, { creation_id: container.id }, 'POST', { config: c });
    }
    if (!receipt?.id) throw new Error('Meta did not return a receipt');
    await deps.store.finishDistribution(article.slug, channel, 'sent', receipt);
    return receipt;
  } catch (error) {
    await deps.store.finishDistribution(article.slug, channel, 'uncertain', { error: error.message });
    throw error;
  }
}

async function dispatch(deps = {}) {
  for (const row of await deps.store.queuedDistributions(2)) {
    try { await sendArticle(row.article, row.channel, deps); }
    catch { console.warn(`[industry-news] ${row.channel} distribution deferred`); }
  }
}

module.exports = { captionFor, sendArticle, dispatch };
