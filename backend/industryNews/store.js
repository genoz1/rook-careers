'use strict';

function queryResult(promise) {
  return Promise.resolve(promise).then(({ data, error }) => {
    if (error) {
      const failure = new Error(`Industry News database operation failed (${error.code || 'unknown'})`);
      failure.code = error.code;
      throw failure;
    }
    return data;
  });
}

class MemoryNewsStore {
  constructor() {
    this.sources = new Map();
    this.items = [];
    this.events = [];
    this.runs = [];
    this.failures = [];
    this.articles = [];
    this.distributions = [];
  }

  async startRun() {
    const run = { id: `run-${this.runs.length + 1}`, status: 'running', startedAt: new Date().toISOString(), metrics: {} };
    this.runs.push(run);
    return run;
  }

  async syncSource(source) { this.sources.set(source.id, { ...source }); }

  async recordSourceSuccess(sourceId, count) {
    const source = this.sources.get(sourceId) || { id: sourceId };
    this.sources.set(sourceId, { ...source, lastStatus: 'success', lastEntryCount: count, lastError: null });
  }

  async recordSourceFailure(sourceId, message) {
    const source = this.sources.get(sourceId) || { id: sourceId };
    this.sources.set(sourceId, { ...source, lastStatus: 'failed', lastError: message });
    this.failures.push({ sourceId, message });
  }

  async ingestItem(item) {
    const existing = this.items.find(candidate =>
      (candidate.sourceId === item.sourceId && candidate.guid === item.guid) ||
      (item.canonicalUrl && candidate.canonicalUrl === item.canonicalUrl));
    if (existing) {
      Object.assign(existing, {
        lastSeenAt: item.lastSeenAt, relevanceStatus: item.relevanceStatus, relevanceReason: item.relevanceReason,
        categories: item.categories, eventType: item.eventType, entities: item.entities, products: item.products,
        identifiers: item.identifiers, automationEligible: item.automationEligible, eligibilityReason: item.eligibilityReason,
        isFresh: item.isFresh, isRoundup: item.isRoundup, processingStatus: item.processingStatus,
      });
      existing.discoverySourceIds = [...new Set([...(existing.discoverySourceIds || [existing.sourceId]), ...(item.discoverySourceIds || [item.sourceId])])];
      existing.feedBuckets = [...new Set([...(existing.feedBuckets || [existing.feedBucket]), ...(item.feedBuckets || [item.feedBucket])].filter(Boolean))];
      return { item: existing, alreadySeen: true };
    }
    const saved = { ...item, id: `item-${this.items.length + 1}` };
    this.items.push(saved);
    return { item: saved, alreadySeen: false };
  }

  async loadRecentCandidates() {
    return this.items.filter(item => ['relevant', 'review'].includes(item.relevanceStatus));
  }

  async loadGenerationCandidates() {
    return this.items.filter(item => item.automationEligible === true);
  }

  async saveClusters(clusters, runId) {
    this.events = clusters.map((cluster, index) => ({ ...cluster, id: `event-${index + 1}`, discoveryRunId: runId }));
    return this.events;
  }

  async finishRun(runId, status, metrics) {
    const run = this.runs.find(candidate => candidate.id === runId);
    Object.assign(run, { status, metrics, finishedAt: new Date().toISOString() });
    return run;
  }

  async candidateReport(runId) {
    const run = this.runs.find(candidate => candidate.id === runId) || this.runs.at(-1) || null;
    return { run, events: this.events };
  }

  async claimGenerationEvent(owner) {
    const event = this.events.find(candidate => candidate.processingStatus !== 'published' && !this.articles.some(article => article.event_id === candidate.id));
    if (!event) return null;
    event.processingStatus = 'generating'; event.leaseOwner = owner;
    return event.id;
  }
  async loadEvent(id) { return this.events.find(event => event.id === id) || null; }
  async finishGeneration(id, owner, article) {
    const event = this.events.find(candidate => candidate.id === id && candidate.leaseOwner === owner);
    if (!event) throw new Error('Industry News generation lease was lost');
    const existing = this.articles.find(candidate => candidate.event_id === id || candidate.slug === article.slug);
    if (existing) return existing;
    const saved = { ...article, published_at: new Date().toISOString(), public_verified_at: null };
    this.articles.push(saved); event.processingStatus = 'published';
    for (const channel of ['facebook', 'instagram']) this.distributions.push({ article_slug: saved.slug, channel, state: 'queued' });
    return saved;
  }
  async failGeneration(id, owner, message) { const event = this.events.find(candidate => candidate.id === id && candidate.leaseOwner === owner); if (event) Object.assign(event, { processingStatus: 'candidate', lastError: message }); }
  async markPublicVerified(slug) { const article = this.articles.find(candidate => candidate.slug === slug); if (article) article.public_verified_at = new Date().toISOString(); }
  async listArticles({ category: wanted, limit = 100 } = {}) { return this.articles.filter(a => a.public_verified_at && (!wanted || a.category === wanted)).slice(0, limit); }
  async articleBySlug(slug) { return this.articles.find(a => a.slug === slug && a.public_verified_at) || null; }
  async claimDistribution(slug, channel) { const row = this.distributions.find(d => d.article_slug === slug && d.channel === channel && d.state === 'queued'); if (!row) return false; row.state = 'sending'; return true; }
  async finishDistribution(slug, channel, state, receipt) { const row = this.distributions.find(d => d.article_slug === slug && d.channel === channel); if (row) Object.assign(row, { state, receipt }); }
  async queuedDistributions(limit = 2) { return this.distributions.filter(d => d.state === 'queued').slice(0, limit).map(d => ({ ...d, article: this.articles.find(a => a.slug === d.article_slug) })); }
}

class SupabaseNewsStore {
  constructor(client) {
    if (!client) throw new Error('Industry News store requires a database client');
    this.client = client;
  }

  async startRun() {
    const rows = await queryResult(this.client.from('industry_news_discovery_runs').insert({ status: 'running' }).select('*'));
    return rows[0];
  }

  async syncSource(source) {
    const row = {
      id: source.id, name: source.name, feed_url: source.feedUrl, canonical_publisher: source.publisher,
      categories: source.categories, authority_tier: source.authorityTier, source_kind: source.kind,
      status: source.status, requires_feed_validation: source.requiresFeedValidation,
    };
    await queryResult(this.client.from('industry_news_sources').upsert(row, { onConflict: 'id' }));
  }

  async recordSourceSuccess(sourceId, count) {
    await queryResult(this.client.from('industry_news_sources').update({
      last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(),
      last_error: null, last_entry_count: count,
    }).eq('id', sourceId));
  }

  async recordSourceFailure(sourceId, message) {
    await queryResult(this.client.from('industry_news_sources').update({
      last_attempt_at: new Date().toISOString(), last_error: String(message).slice(0, 500),
    }).eq('id', sourceId));
  }

  async ingestItem(item, runId) {
    let existing = await queryResult(this.client.from('industry_news_feed_items').select('*')
      .eq('source_id', item.sourceId).eq('guid', item.guid).maybeSingle());
    if (!existing && item.canonicalUrl) existing = await queryResult(this.client.from('industry_news_feed_items').select('*')
      .eq('canonical_url', item.canonicalUrl).maybeSingle());
    if (existing) {
      const saved = fromRow(existing);
      const discoverySourceIds = [...new Set([...(saved.discoverySourceIds || [saved.sourceId]), ...(item.discoverySourceIds || [item.sourceId])])];
      const feedBuckets = [...new Set([...(saved.feedBuckets || [saved.feedBucket]), ...(item.feedBuckets || [item.feedBucket])].filter(Boolean))];
      await queryResult(this.client.from('industry_news_feed_items').update({
        last_seen_at: item.lastSeenAt, discovery_source_ids: discoverySourceIds, feed_buckets: feedBuckets,
        relevance_status: item.relevanceStatus, relevance_reason: item.relevanceReason, categories: item.categories,
        event_type: item.eventType, entities: item.entities, products: item.products, identifiers: item.identifiers,
        automation_eligible: item.automationEligible === true, eligibility_reason: item.eligibilityReason,
        is_fresh: item.isFresh === true, is_roundup: item.isRoundup === true, processing_status: item.processingStatus,
      }).eq('id', existing.id));
      return { item: { ...saved, ...item, lastSeenAt: item.lastSeenAt, discoverySourceIds, feedBuckets }, alreadySeen: true };
    }
    const row = toRow(item, runId);
    try {
      const rows = await queryResult(this.client.from('industry_news_feed_items').insert(row).select('*'));
      return { item: fromRow(rows[0]), alreadySeen: false };
    } catch (error) {
      if (error.code !== '23505') throw error;
      return { item, alreadySeen: true };
    }
  }

  async loadRecentCandidates(days = 14) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await queryResult(this.client.from('industry_news_feed_items').select('*,industry_news_sources(name,authority_tier,source_kind,categories)')
      .in('relevance_status', ['relevant', 'review']).gte('first_seen_at', since).order('first_seen_at'));
    return rows.map(fromRow);
  }

  async loadGenerationCandidates() {
    const rows = await queryResult(this.client.from('industry_news_feed_items').select('*,industry_news_sources(name,authority_tier,source_kind,categories)')
      .eq('automation_eligible', true).eq('processing_status', 'candidate').order('published_at'));
    return rows.map(fromRow);
  }

  async saveClusters(clusters, runId) {
    const saved = [];
    for (const cluster of clusters) {
      const eventRows = await queryResult(this.client.from('industry_news_events').upsert({
        cluster_key: cluster.clusterKey, representative_title: cluster.representativeTitle,
        primary_category: cluster.category, categories: cluster.categories, event_type: cluster.eventType,
        entities: cluster.entities, products: cluster.products, identifiers: cluster.identifiers,
        earliest_publication_at: cluster.earliestPublicationAt, latest_publication_at: cluster.latestPublicationAt,
        relevance_status: cluster.relevanceStatus, relevance_reason: cluster.relevanceReason,
        has_authoritative_evidence: cluster.hasAuthoritativeEvidence,
        source_count: new Set(cluster.items.map(item => item.originalPublisher || item.sourceName || item.sourceId)).size,
        discovery_run_id: runId, updated_at: new Date().toISOString(),
      }, { onConflict: 'cluster_key' }).select('*'));
      const event = eventRows[0];
      const relations = cluster.items.filter(item => item.id).map(item => ({ event_id: event.id, feed_item_id: item.id }));
      if (relations.length) await queryResult(this.client.from('industry_news_event_sources').upsert(relations, { onConflict: 'event_id,feed_item_id' }));
      saved.push({ ...cluster, id: event.id });
    }
    return saved;
  }

  async finishRun(runId, status, metrics) {
    const rows = await queryResult(this.client.from('industry_news_discovery_runs').update({
      status, metrics, finished_at: new Date().toISOString(),
    }).eq('id', runId).select('*'));
    return rows[0];
  }

  async candidateReport(runId) {
    const runQuery = this.client.from('industry_news_discovery_runs').select('*').order('started_at', { ascending: false }).limit(1);
    const run = runId
      ? await queryResult(this.client.from('industry_news_discovery_runs').select('*').eq('id', runId).maybeSingle())
      : (await queryResult(runQuery))[0] || null;
    const rows = await queryResult(this.client.from('industry_news_events').select('*,industry_news_event_sources(industry_news_feed_items(*,industry_news_sources(name,authority_tier,source_kind)))')
      .order('latest_publication_at', { ascending: false }).limit(500));
    return { run, events: rows.map(eventFromRow) };
  }

  async claimGenerationEvent(owner, freshnessHours) {
    return queryResult(this.client.rpc('claim_industry_news_event', { p_owner: owner, p_freshness_hours: freshnessHours }));
  }

  async loadEvent(id) {
    const row = await queryResult(this.client.from('industry_news_events').select('*,industry_news_event_sources(industry_news_feed_items(*,industry_news_sources(name,authority_tier,source_kind)))').eq('id', id).single());
    return eventFromRow(row);
  }

  async finishGeneration(id, owner, article) {
    const row = await queryResult(this.client.rpc('publish_industry_news_article', { p_event: id, p_owner: owner, p_article: article }));
    return row;
  }

  async failGeneration(id, owner, message) {
    await queryResult(this.client.rpc('fail_industry_news_generation', { p_event: id, p_owner: owner, p_error: String(message).slice(0, 500) }));
  }

  async markPublicVerified(slug) {
    await queryResult(this.client.from('industry_news_articles').update({ public_verified_at: new Date().toISOString() }).eq('slug', slug).is('public_verified_at', null));
  }

  async listArticles({ category: wanted, limit = 100 } = {}) {
    let query = this.client.from('industry_news_articles').select('*').not('public_verified_at', 'is', null).order('published_at', { ascending: false }).limit(limit);
    if (wanted) query = query.eq('category', wanted);
    return queryResult(query);
  }

  async articleBySlug(slug) {
    return queryResult(this.client.from('industry_news_articles').select('*').eq('slug', slug).not('public_verified_at', 'is', null).maybeSingle());
  }

  async claimDistribution(slug, channel) {
    const rows = await queryResult(this.client.from('industry_news_distribution').update({ state: 'sending', updated_at: new Date().toISOString() }).eq('article_slug', slug).eq('channel', channel).eq('state', 'queued').select('article_slug'));
    return !!rows?.length;
  }

  async finishDistribution(slug, channel, state, receipt) {
    await queryResult(this.client.from('industry_news_distribution').update({ state, receipt, updated_at: new Date().toISOString() }).eq('article_slug', slug).eq('channel', channel));
  }

  async queuedDistributions(limit = 2) {
    const rows = await queryResult(this.client.from('industry_news_distribution').select('article_slug,channel,industry_news_articles(*)').eq('state', 'queued').limit(limit));
    return rows.filter(row => row.industry_news_articles?.public_verified_at).map(row => ({ ...row, article: row.industry_news_articles }));
  }
}

function toRow(item, runId) {
  return {
    source_id: item.sourceId, discovery_run_id: runId, guid: item.guid, canonical_url: item.canonicalUrl,
    discovery_source_ids: item.discoverySourceIds || [item.sourceId], feed_buckets: item.feedBuckets || [item.feedBucket],
    original_publisher: item.originalPublisher, author_byline: item.authorByline, image_url: item.imageUrl,
    title: item.title, rss_summary: item.summary, published_at: item.publishedAt, source_updated_at: item.updatedAt,
    first_seen_at: item.firstSeenAt, last_seen_at: item.lastSeenAt, retrieval_hash: item.retrievalHash,
    relevance_status: item.relevanceStatus, relevance_reason: item.relevanceReason, categories: item.categories,
    event_type: item.eventType, entities: item.entities, products: item.products, identifiers: item.identifiers,
    automation_eligible: item.automationEligible === true, eligibility_reason: item.eligibilityReason,
    is_fresh: item.isFresh === true, is_roundup: item.isRoundup === true,
    processing_status: item.processingStatus || 'discovered',
  };
}

function fromRow(row) {
  const source = row.industry_news_sources || {};
  return {
    id: row.id, sourceId: row.source_id, discoverySourceIds: row.discovery_source_ids || row.discoverySourceIds || [row.source_id],
    feedBucket: source.name || row.feedBucket,
    feedBuckets: row.feed_buckets || row.feedBuckets || [source.name || row.feedBucket].filter(Boolean),
    originalPublisher: row.original_publisher || row.originalPublisher || null,
    authorByline: row.author_byline || row.authorByline || null,
    sourceName: row.original_publisher || row.originalPublisher || row.sourceName || source.name,
    authorityTier: source.authority_tier || row.authorityTier, sourceKind: source.source_kind || row.sourceKind,
    sourceCategories: source.categories || row.sourceCategories || [], guid: row.guid, canonicalUrl: row.canonical_url || row.canonicalUrl,
    imageUrl: row.image_url || row.imageUrl || null,
    title: row.title, summary: row.rss_summary ?? row.summary, publishedAt: row.published_at || row.publishedAt,
    updatedAt: row.source_updated_at || row.updatedAt, firstSeenAt: row.first_seen_at || row.firstSeenAt,
    lastSeenAt: row.last_seen_at || row.lastSeenAt, retrievalHash: row.retrieval_hash || row.retrievalHash,
    relevanceStatus: row.relevance_status || row.relevanceStatus, relevanceReason: row.relevance_reason || row.relevanceReason,
    categories: row.categories || [], eventType: row.event_type || row.eventType,
    automationEligible: row.automation_eligible ?? row.automationEligible ?? false,
    eligibilityReason: row.eligibility_reason || row.eligibilityReason || null,
    isFresh: row.is_fresh ?? row.isFresh ?? false, isRoundup: row.is_roundup ?? row.isRoundup ?? false,
    entities: row.entities || [], products: row.products || [], identifiers: row.identifiers || [],
  };
}

function eventFromRow(row) {
  const relations = row.industry_news_event_sources || [];
  const items = relations.map(relation => fromRow(relation.industry_news_feed_items || {}));
  return {
    id: row.id, clusterKey: row.cluster_key, representativeTitle: row.representative_title,
    category: row.primary_category, categories: row.categories || [], eventType: row.event_type,
    entities: row.entities || [], products: row.products || [], identifiers: row.identifiers || [],
    earliestPublicationAt: row.earliest_publication_at, latestPublicationAt: row.latest_publication_at,
    relevanceStatus: row.relevance_status, relevanceReason: row.relevance_reason,
    hasAuthoritativeEvidence: row.has_authoritative_evidence, items,
  };
}

module.exports = { MemoryNewsStore, SupabaseNewsStore, queryResult, toRow, fromRow, eventFromRow };
