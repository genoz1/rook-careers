'use strict';

const { getSources } = require('./catalog');
const { getFlags, discoveryEnabled } = require('./config');
const { fetchFeeds } = require('./feedReader');
const { normalizeItem } = require('./normalize');
const { evaluateRelevance } = require('./relevance');
const { decorate, clusterItems } = require('./cluster');
const { buildMetrics, buildCandidateReport } = require('./report');
const { SupabaseNewsStore } = require('./store');
const { automationEligibility } = require('./eligibility');

function preparedItem(raw, source, now = new Date(), env = process.env) {
  const classified = decorate(normalizeItem(raw, source, now));
  const relevance = evaluateRelevance(classified);
  const item = {
    ...classified,
    relevanceStatus: relevance.status,
    relevanceReason: relevance.reason,
    categories: relevance.categories,
  };
  const eligibility = automationEligibility(item, source, now, env);
  return { ...item, automationEligible: eligibility.eligible, eligibilityReason: eligibility.reason,
    isFresh: eligibility.fresh, isRoundup: eligibility.roundup,
    processingStatus: eligibility.eligible ? 'candidate' : relevance.status === 'rejected' ? 'rejected' : 'held' };
}

async function runDiscovery(deps = {}) {
  if (!deps.allowFixtureRun && !discoveryEnabled(deps.env || process.env)) return { state: 'disabled', flags: getFlags(deps.env || process.env) };
  const store = deps.store;
  if (!store) throw new Error('Industry News discovery requires an injected store');
  const sources = deps.sources || getSources(deps.env || process.env);
  const now = deps.now || new Date();
  const run = await store.startRun();
  const ingested = [];
  let malformedEntries = 0;
  try {
    for (const source of sources) await store.syncSource(source);
    const outcomes = await (deps.fetchFeeds || fetchFeeds)(sources, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs });
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        await store.recordSourceFailure(outcome.source.id, outcome.error);
        continue;
      }
      await store.recordSourceSuccess(outcome.source.id, outcome.items.length);
      for (const raw of outcome.items) {
        try {
          const item = preparedItem(raw, outcome.source, now, deps.env || process.env);
          ingested.push(await store.ingestItem(item, run.id));
        } catch {
          malformedEntries += 1;
        }
      }
    }
    const candidates = await store.loadGenerationCandidates();
    const clusters = clusterItems(candidates);
    await store.saveClusters(clusters, run.id);
    const metrics = { ...buildMetrics({ outcomes, ingested, clusters }), malformedEntries };
    const status = metrics.feedsFailed ? 'partial' : 'complete';
    const finished = await store.finishRun(run.id, status, metrics);
    return { state: status, run: finished, metrics, clusters };
  } catch (error) {
    await store.finishRun(run.id, 'failed', { error: error.message, malformedEntries });
    throw error;
  }
}

let running = false;
function start(deps = {}) {
  if (!discoveryEnabled(deps.env || process.env)) return false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runDiscovery(deps);
      const flags = getFlags(deps.env || process.env);
      if (flags.aiGeneration && flags.automaticPublication) {
        await require('./publication').tick({ ...deps, social: require('./social') });
      }
    }
    catch (error) { console.error('[industry-news] discovery failed:', error.message); }
    finally { running = false; }
  };
  setTimeout(run, 30000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
  return true;
}

function defaultStore() {
  return new SupabaseNewsStore(require('../resources/store').db());
}

async function main() {
  const command = process.argv[2];
  if (command === 'discover') {
    if (!discoveryEnabled()) throw new Error('Set INDUSTRY_NEWS_ENABLED=true and INDUSTRY_NEWS_RSS_POLLING_ENABLED=true to run discovery');
    console.log(JSON.stringify(await runDiscovery({ store: defaultStore() }), null, 2));
    return;
  }
  if (command === 'report') {
    if (!getFlags().industryNews) throw new Error('Set INDUSTRY_NEWS_ENABLED=true to read the candidate report');
    console.log(JSON.stringify(buildCandidateReport(await defaultStore().candidateReport(process.argv[3] || null)), null, 2));
    return;
  }
  throw new Error('Use discover | report [run-id]');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { preparedItem, runDiscovery, start };
