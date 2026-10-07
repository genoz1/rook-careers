const cheerio = require('cheerio');
const { titleLooksRelevant } = require('../relevanceFilter');
const { normalizeCompanyName } = require('./pipeline');
const { websiteFromPublicSignals } = require('./marketSignals');

const PUBLIC_JOB_QUERIES = [
  { query: 'medical sales', industry: 'Healthcare' },
  { query: 'medical device sales', industry: 'Medical Device' },
  { query: 'diagnostics laboratory sales', industry: 'Diagnostics / Laboratory' },
  { query: 'pharmaceutical biotech sales', industry: 'Pharmaceutical / Biotech' },
  { query: 'veterinary sales', industry: 'Veterinary' },
  { query: 'animal health sales', industry: 'Animal Health' },
];

const NON_EMPLOYER = /^(confidential|company|employer|self-employed|undisclosed|unknown)$/i;
const AGENCY = /\b(recruit(?:ing|ment|er)?|staffing|talent solutions|executive search|placement|personnel|workforce solutions)\b/i;

function selectedPublicQueries(now = new Date(), count = 2) {
  const day = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  const start = (day * count) % PUBLIC_JOB_QUERIES.length;
  return Array.from({ length: Math.min(count, PUBLIC_JOB_QUERIES.length) }, (_, index) => PUBLIC_JOB_QUERIES[(start + index) % PUBLIC_JOB_QUERIES.length]);
}

function plausibleCompany(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 160 && !NON_EMPLOYER.test(name) && !AGENCY.test(name);
}

async function fetchPublicLinkedInSignals(definition, { httpFetch = fetch } = {}) {
  const url = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  url.search = new URLSearchParams({ keywords: definition.query, location: 'United States', start: '0' });
  const response = await httpFetch(url, { signal: AbortSignal.timeout(15_000), headers: {
    Accept: 'text/html', 'User-Agent': 'ROOK-Careers/1.0 (+https://rookcareers.com)',
  } });
  if (!response.ok) throw new Error(`Public LinkedIn jobs returned ${response.status}`);
  const html = await response.text();
  if (/captcha|authwall|sign in to view/i.test(html)) throw new Error('Public LinkedIn jobs became access-restricted');
  const $ = cheerio.load(html);
  return $('li .base-search-card').map((_, element) => {
    const card = $(element);
    const companyName = card.find('.base-search-card__subtitle').first().text().replace(/\s+/g, ' ').trim();
    const title = card.find('.base-search-card__title').first().text().replace(/\s+/g, ' ').trim();
    const jobUrl = card.find('a.base-card__full-link').first().attr('href') || null;
    const sourceId = String(card.attr('data-entity-urn') || '').split(':').pop() || null;
    return { companyName, title, jobUrl, sourceId, industry: definition.industry, query: definition.query, signalSource: 'linkedin-public-jobs' };
  }).get().filter((item) => plausibleCompany(item.companyName) && titleLooksRelevant(item.title));
}

async function fetchJobicySignals({ httpFetch = fetch } = {}) {
  const url = 'https://jobicy.com/api/v2/remote-jobs?count=50&geo=usa&tag=sales';
  const response = await httpFetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'User-Agent': 'ROOK-Careers/1.0 (+https://rookcareers.com)' } });
  if (!response.ok) throw new Error(`Jobicy public jobs returned ${response.status}`);
  const payload = await response.json();
  return (payload.jobs || []).map((job) => ({
    companyName: job.companyName, title: job.jobTitle, jobUrl: job.url,
    sourceId: job.id ? String(job.id) : null, industry: null, query: 'public sales feed',
    signalSource: 'jobicy-public-api', description: `${job.jobExcerpt || ''} ${job.jobDescription || ''}`,
  })).filter((item) => plausibleCompany(item.companyName) && titleLooksRelevant(item.title)
    && /\b(medical|healthcare|health care|device|diagnostic|laborator|pharma|biotech|life science|veterinar|animal health)\b/i.test(`${item.title} ${item.description}`));
}

function employerByName(employers, companyName) {
  const normalized = normalizeCompanyName(companyName);
  return employers.find((employer) => normalizeCompanyName(employer.company_name) === normalized) || null;
}

async function discoverPublicJobSignals({
  now = new Date(), queryLimit = 2, signalLimit = 12, knownEmployers = [],
  fetchLinkedIn = fetchPublicLinkedInSignals, fetchJobicy = fetchJobicySignals,
  resolveWebsite = websiteFromPublicSignals,
} = {}) {
  const definitions = selectedPublicQueries(now, queryLimit);
  const rawSignals = [];
  const stats = { queries: definitions.length, fetched_signals: 0, relevant_signals: 0, duplicate_companies: 0, source_errors: [] };
  for (const definition of definitions) {
    try { rawSignals.push(...await fetchLinkedIn(definition)); }
    catch (error) { stats.source_errors.push({ source: 'linkedin-public-jobs', query: definition.query, reason: error.message }); }
  }
  try { rawSignals.push(...await fetchJobicy()); }
  catch (error) { stats.source_errors.push({ source: 'jobicy-public-api', reason: error.message }); }
  stats.fetched_signals = rawSignals.length;

  const byCompany = new Map();
  for (const item of rawSignals) {
    if (!plausibleCompany(item.companyName) || !titleLooksRelevant(item.title)) continue;
    stats.relevant_signals++;
    const key = normalizeCompanyName(item.companyName);
    if (byCompany.has(key)) { stats.duplicate_companies++; continue; }
    byCompany.set(key, item);
  }

  const existing = [];
  const unknown = [];
  for (const item of byCompany.values()) (employerByName(knownEmployers, item.companyName) ? existing : unknown).push(item);
  const selected = unknown.slice(0, signalLimit);
  const signals = [];
  for (const item of selected) {
    let websiteEvidence = null;
    try { websiteEvidence = await resolveWebsite(item.companyName, { industry: item.industry }); }
    catch (error) { websiteEvidence = { error: error.message }; }
    signals.push({
      company_name: item.companyName, company_website: websiteEvidence?.website || null,
      job_url: item.jobUrl, job_title: item.title, industry: item.industry,
      signal_source: item.signalSource, source_signal_id: item.sourceId,
      source_evidence: { query: item.query, website_resolution: websiteEvidence },
    });
  }
  return { signals, stats: {
    ...stats, unique_companies: byCompany.size, already_monitored: existing.length,
    genuinely_new: unknown.length, selected_unknown: selected.length,
    official_websites_resolved: signals.filter((signal) => signal.company_website).length,
    official_websites_unresolved: signals.filter((signal) => !signal.company_website).length,
  } };
}

module.exports = {
  PUBLIC_JOB_QUERIES, selectedPublicQueries, plausibleCompany,
  fetchPublicLinkedInSignals, fetchJobicySignals, discoverPublicJobSignals,
};
