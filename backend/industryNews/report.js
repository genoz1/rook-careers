'use strict';

function increment(target, key) {
  const label = key || 'unknown';
  target[label] = (target[label] || 0) + 1;
}

function sourceIdentity(item) {
  return item.originalPublisher || item.sourceName || item.sourceId;
}

function buildMetrics({ outcomes, ingested, clusters }) {
  const metrics = {
    feedsAttempted: outcomes.length,
    feedsSuccessful: outcomes.filter(outcome => outcome.ok).length,
    feedsFailed: outcomes.filter(outcome => !outcome.ok).length,
    rawEntriesDiscovered: outcomes.reduce((sum, outcome) => sum + outcome.items.length, 0),
    alreadySeenEntries: ingested.filter(row => row.alreadySeen).length,
    rejectedEntries: ingested.filter(row => row.item.relevanceStatus === 'rejected').length,
    reviewEntries: ingested.filter(row => row.item.relevanceStatus === 'review').length,
    relevantEntries: ingested.filter(row => row.item.relevanceStatus === 'relevant').length,
    staleIneligibleEntries: ingested.filter(row => !row.item.isFresh).length,
    roundupIneligibleEntries: ingested.filter(row => row.item.isRoundup).length,
    generationEligibleEntries: ingested.filter(row => row.item.automationEligible).length,
    unknownEventEntries: ingested.filter(row => row.item.eventType === 'unknown').length,
    uniqueEventClusters: clusters.length,
    multiSourceClusters: clusters.filter(cluster => new Set(cluster.items.map(sourceIdentity)).size > 1).length,
    singleSourceClusters: clusters.filter(cluster => new Set(cluster.items.map(sourceIdentity)).size === 1).length,
    categoryBreakdown: {},
    eventTypeBreakdown: {},
  };
  for (const cluster of clusters) {
    increment(metrics.categoryBreakdown, cluster.category);
    increment(metrics.eventTypeBreakdown, cluster.eventType);
  }
  return metrics;
}

function candidateRows(events) {
  return events.map(event => {
    const sources = [...new Map(event.items.map(item => {
      const source = {
        name: sourceIdentity(item), byline: item.authorByline || null, url: item.canonicalUrl,
        feedBucket: item.feedBucket || null, feedBuckets: item.feedBuckets || [item.feedBucket].filter(Boolean),
      };
      return [`${source.name}|${source.url || ''}`, source];
    })).values()];
    return {
      headline: event.representativeTitle,
      category: event.category,
      eventType: event.eventType,
      entities: event.entities,
      products: event.products,
      supportingFeedItems: event.items.length,
      sourceCount: new Set(event.items.map(sourceIdentity)).size,
      sources,
      sourceNames: [...new Set(sources.map(source => source.name))],
      feedBuckets: [...new Set(event.items.flatMap(item => item.feedBuckets || [item.feedBucket]).filter(Boolean))],
      sourceUrls: [...new Set(sources.map(source => source.url).filter(Boolean))],
      earliestPublicationAt: event.earliestPublicationAt,
      latestPublicationAt: event.latestPublicationAt,
      relevanceStatus: event.relevanceStatus,
      relevanceReason: event.relevanceReason,
      hasAuthoritativeEvidence: event.hasAuthoritativeEvidence,
    };
  });
}

function buildCandidateReport({ run, events }) {
  return {
    generatedAt: new Date().toISOString(),
    run: run ? { id: run.id, status: run.status, startedAt: run.startedAt || run.started_at, finishedAt: run.finishedAt || run.finished_at, metrics: run.metrics || {} } : null,
    candidates: candidateRows(events || []),
  };
}

module.exports = { sourceIdentity, buildMetrics, candidateRows, buildCandidateReport };
