const { fetchAdzunaJobs } = require('../adapters/adzuna');
const { titleLooksRelevant } = require('../relevanceFilter');
const { normalizeCompanyName } = require('./pipeline');

const MARKET_QUERIES = [
  { query: 'medical device sales', industry: 'Medical Device' },
  { query: 'diagnostics sales', industry: 'Diagnostics / Laboratory' },
  { query: 'laboratory sales representative', industry: 'Diagnostics / Laboratory' },
  { query: 'pharmaceutical sales representative', industry: 'Pharmaceutical' },
  { query: 'biotech account executive', industry: 'Biotech' },
  { query: 'healthcare sales representative', industry: 'Healthcare' },
  { query: 'veterinary sales representative', industry: 'Veterinary' },
  { query: 'animal health sales', industry: 'Animal Health' },
  { query: 'surgical sales representative', industry: 'Medical Device' },
  { query: 'capital equipment sales healthcare', industry: 'Medical Device' },
  { query: 'clinical sales specialist', industry: 'Medical Device' },
  { query: 'life science account executive', industry: 'Biotech' },
];

const NON_EMPLOYER_NAMES = /^(confidential|undisclosed|company|employer|client|our client|stealth|n\/a|na|unknown)$/i;
const AGENCY_NAME = /\b(recruit(?:ing|ment|er)?|staffing|talent solutions|executive search|headhunt|placement|personnel|workforce solutions|medreps|sales talent|insight global|kforce|adecco|randstad|manpower|robert half)\b/i;
const NON_OFFICIAL_HOST = /(?:^|\.)(?:wikipedia\.org|wikidata\.org|linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|crunchbase\.com|indeed\.com|ziprecruiter\.com|adzuna\.com|greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|icims\.com)$/i;

function selectedQueries(now = new Date(), count = 4) {
  const utcDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  const start = (utcDay * count) % MARKET_QUERIES.length;
  return Array.from({ length: Math.min(count, MARKET_QUERIES.length) }, (_, index) => MARKET_QUERIES[(start + index) % MARKET_QUERIES.length]);
}

function plausibleEmployerName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 160 && !NON_EMPLOYER_NAMES.test(name) && !AGENCY_NAME.test(name);
}

function safeOfficialWebsite(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || NON_OFFICIAL_HOST.test(url.hostname.toLowerCase())) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function websiteFromWikidata(companyName, { httpFetch = fetch } = {}) {
  const searchUrl = new URL('https://www.wikidata.org/w/api.php');
  searchUrl.search = new URLSearchParams({
    action: 'wbsearchentities', search: companyName, language: 'en', uselang: 'en', type: 'item', limit: '5', format: 'json', origin: '*',
  });
  const searchResponse = await httpFetch(searchUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json', 'User-Agent': 'ROOK-Careers/1.0 (public employer discovery; contact@rookcareers.com)' } });
  if (!searchResponse.ok) throw new Error(`Wikidata search returned ${searchResponse.status}`);
  const search = await searchResponse.json();
  const normalized = normalizeCompanyName(companyName);
  const exact = (search.search || []).filter((item) =>
    [item.label, ...(item.aliases || [])].some((label) => normalizeCompanyName(label) === normalized)
  ).slice(0, 5);
  if (!exact.length) return null;

  const entityUrl = new URL('https://www.wikidata.org/w/api.php');
  entityUrl.search = new URLSearchParams({ action: 'wbgetentities', ids: exact.map((item) => item.id).join('|'), props: 'claims', format: 'json', origin: '*' });
  const entityResponse = await httpFetch(entityUrl, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json', 'User-Agent': 'ROOK-Careers/1.0 (public employer discovery; contact@rookcareers.com)' } });
  if (!entityResponse.ok) throw new Error(`Wikidata entity lookup returned ${entityResponse.status}`);
  const entities = (await entityResponse.json()).entities || {};
  for (const item of exact) {
    const claims = entities[item.id]?.claims?.P856 || [];
    for (const claim of claims) {
      const website = safeOfficialWebsite(claim?.mainsnak?.datavalue?.value);
      if (website) return { website, entity_id: item.id, match: 'exact_label_or_alias' };
    }
  }
  return null;
}

function nameDerivedDomains(companyName, industry = '') {
  const normalized = normalizeCompanyName(companyName);
  const tokens = normalized.split(' ').filter(Boolean);
  const useful = tokens.filter((token) => !['group', 'companies', 'products', 'services', 'supply'].includes(token));
  const compact = useful.join('');
  const domains = [];
  if (compact.length >= 3) domains.push(`${compact}.com`);
  if (/veterinary|animal health/i.test(industry) && compact.length >= 3 && compact.length <= 12 && !compact.endsWith('vet')) {
    domains.push(`${compact}vet.com`);
  }
  return [...new Set(domains)].slice(0, 2);
}

function pageCorroboratesCompany(companyName, url, html) {
  const companyTokens = normalizeCompanyName(companyName).split(' ').filter((token) => token.length >= 3);
  if (!companyTokens.length) return false;
  const evidence = normalizeCompanyName(`${new URL(url).hostname} ${String(html || '').slice(0, 150_000)}`);
  return companyTokens.every((token) => evidence.includes(token));
}

async function websiteFromNameDerivedDomain(companyName, { industry = '', httpFetch = fetch } = {}) {
  for (const domain of nameDerivedDomains(companyName, industry)) {
    try {
      const response = await httpFetch(`https://${domain}`, {
        redirect: 'follow', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'ROOK-Careers/1.0 (public employer discovery; contact@rookcareers.com)' },
      });
      const website = safeOfficialWebsite(response.url || `https://${domain}`);
      if (!response.ok || !website) continue;
      const html = await response.text();
      if (!pageCorroboratesCompany(companyName, website, html)) continue;
      return { website, domain_guess: domain, match: 'name_derived_domain_with_page_identity' };
    } catch {
      // A failed guess is expected; the candidate remains unresolved and retryable.
    }
  }
  return null;
}

async function websiteFromPublicSignals(companyName, options = {}) {
  const wikidata = await websiteFromWikidata(companyName, options);
  if (wikidata) return wikidata;
  return websiteFromNameDerivedDomain(companyName, options);
}

function employerByName(employers, companyName) {
  const normalized = normalizeCompanyName(companyName);
  return (employers || []).find((employer) => normalizeCompanyName(employer.company_name) === normalized) || null;
}

async function discoverMarketSignals({
  now = new Date(),
  queryLimit = 4,
  resultLimit = 50,
  signalLimit = 20,
  knownEmployers = [],
  fetchJobs = fetchAdzunaJobs,
  resolveWebsite = websiteFromPublicSignals,
} = {}) {
  const queries = selectedQueries(now, queryLimit);
  const byCompany = new Map();
  const stats = { queries: queries.length, fetched_jobs: 0, relevant_jobs: 0, rejected_agency_or_generic: 0, duplicate_jobs: 0, unique_companies: 0, websites_resolved: 0, website_unresolved: 0, existing_employer_signals: 0 };

  for (const definition of queries) {
    let jobs;
    try {
      jobs = await fetchJobs(definition.query, 1, resultLimit);
    } catch (error) {
      stats.query_errors = (stats.query_errors || 0) + 1;
      continue;
    }
    stats.fetched_jobs += jobs.length;
    for (const raw of jobs) {
      if (!titleLooksRelevant(raw.title || '')) continue;
      stats.relevant_jobs++;
      const companyName = String(raw.company?.display_name || '').replace(/\s+/g, ' ').trim();
      if (!plausibleEmployerName(companyName)) {
        stats.rejected_agency_or_generic++;
        continue;
      }
      const key = normalizeCompanyName(companyName);
      if (!key) continue;
      if (byCompany.has(key)) {
        stats.duplicate_jobs++;
        continue;
      }
      byCompany.set(key, { raw, companyName, industry: definition.industry, query: definition.query });
    }
  }

  const signals = [];
  for (const candidate of [...byCompany.values()].slice(0, signalLimit)) {
    const known = employerByName(knownEmployers, candidate.companyName);
    let companyWebsite = known?.company_website || null;
    let websiteEvidence = known ? { match: 'existing_employer', employer_id: known.id } : null;
    if (known) stats.existing_employer_signals++;
    if (!known) {
      try {
        websiteEvidence = await resolveWebsite(candidate.companyName, { industry: candidate.industry });
        companyWebsite = websiteEvidence?.website || null;
      } catch (error) {
        websiteEvidence = { error: error.message };
      }
    }
    if (companyWebsite) stats.websites_resolved++;
    else stats.website_unresolved++;
    signals.push({
      company_name: candidate.companyName,
      company_website: companyWebsite,
      job_url: candidate.raw.redirect_url || null,
      job_title: candidate.raw.title || null,
      industry: candidate.industry,
      signal_source: 'adzuna-public-api',
      source_signal_id: candidate.raw.id ? String(candidate.raw.id) : null,
      source_evidence: {
        query: candidate.query,
        location: candidate.raw.location?.display_name || null,
        date_posted: candidate.raw.created || null,
        website_resolution: websiteEvidence,
      },
    });
  }
  stats.unique_companies = byCompany.size;
  stats.emitted_signals = signals.length;
  return { queries: queries.map((item) => item.query), signals, stats };
}

module.exports = {
  MARKET_QUERIES,
  selectedQueries,
  plausibleEmployerName,
  safeOfficialWebsite,
  websiteFromWikidata,
  nameDerivedDomains,
  pageCorroboratesCompany,
  websiteFromNameDerivedDomain,
  websiteFromPublicSignals,
  employerByName,
  discoverMarketSignals,
};
