const cheerio = require('cheerio');
const net = require('node:net');
const dns = require('node:dns').promises;
const { parseCareersPage } = require('../adapters/customHtml');
const { titleLooksRelevant } = require('../relevanceFilter');

const ATS_HOST = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|icims\.com|applicantpro\.com|jobvite\.com|pinpointhq\.com|paylocity\.com|applytojob\.com|oraclecloud\.com|ultipro\.com|adp\.com|kula\.ai/i;
const CAREER_TEXT = /career|job|opening|join (?:us|our team)|work with us|opportunit/i;
const MULTIPART_SUFFIXES = new Set(['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.in']);

function cleanUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function normalizedHost(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function registrableDomain(value) {
  const host = value.includes('://') ? normalizedHost(value) : String(value || '').toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const tail = parts.slice(-2).join('.');
  return MULTIPART_SUFFIXES.has(tail) ? parts.slice(-3).join('.') : tail;
}

function isPrivateLiteral(host) {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  return net.isIP(host) === 6 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:127.') || host.startsWith('::ffff:10.') || host.startsWith('::ffff:192.168.'));
}

async function assertPublicHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateLiteral(url.hostname.toLowerCase())) {
    throw new Error('Discovery only fetches public HTTP(S) URLs');
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateLiteral(address.toLowerCase()))) throw new Error('Discovery refused a host resolving to a private address');
  return url;
}

async function fetchDocument(url, { maxBytes = 3_000_000 } = {}) {
  let current = url;
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicHttpUrl(current);
    response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'ROOK-Careers/1.0 (public employer-source discovery)',
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Discovery redirect lacked Location: ${current}`);
    current = new URL(location, current).href;
    if (redirects === 5) throw new Error('Discovery redirect limit exceeded');
  }
  if (!response.ok) throw new Error(`Discovery fetch ${response.status}: ${url}`);
  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) throw new Error('Discovery page exceeds size limit');
  return { url: response.url || current, html, status: response.status };
}

function pageLinks(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const links = [];
  $('a[href],iframe[src],script[src],form[action],link[href]').each((_, node) => {
    const raw = $(node).attr('href') || $(node).attr('src') || $(node).attr('action');
    const url = cleanUrl(raw, baseUrl);
    if (!url) return;
    links.push({ url, text: $(node).text().replace(/\s+/g, ' ').trim(), rel: $(node).attr('rel') || '', type: $(node).attr('type') || '' });
  });
  const meta = $('meta[http-equiv="refresh" i]').attr('content');
  const refresh = meta && cleanUrl(meta.replace(/^.*?url\s*=\s*/i, ''), baseUrl);
  if (refresh) links.push({ url: refresh, text: 'redirect', rel: 'refresh' });
  const rawUrls = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (const raw of rawUrls.slice(0, 200)) {
    const url = cleanUrl(raw, baseUrl);
    if (url && !links.some((link) => link.url === url)) links.push({ url, text: 'embedded metadata', rel: '', type: '' });
  }
  return links;
}

function detectFromUrl(value) {
  const url = cleanUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  let match;

  if (/^(?:job-boards|boards)\.greenhouse\.io$/.test(host) && segments[0]) return { ats_type: 'greenhouse', ats_identifier: segments[0], source_url: url };
  if (host === 'boards-api.greenhouse.io' && segments[0] === 'v1' && segments[1] === 'boards' && segments[2]) return { ats_type: 'greenhouse', ats_identifier: segments[2], source_url: url };
  if (host === 'jobs.lever.co' && segments[0]) return { ats_type: 'lever', ats_identifier: segments[0], source_url: url };
  if (host === 'jobs.ashbyhq.com' && segments[0]) return { ats_type: 'ashby', ats_identifier: segments[0], source_url: url };
  if ((host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') && segments[0]) return { ats_type: 'smartrecruiters', ats_identifier: segments[0], source_url: url };
  if (host === 'apply.workable.com' && segments[0]) return { ats_type: 'workable', ats_identifier: segments[0], source_url: url };
  if ((match = host.match(/^([a-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com$/i))) {
    const site = segments.find((part) => !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(part));
    if (site) return { ats_type: 'workday', ats_identifier: `${match[1]}|${match[2]}|${site}`, source_url: url };
  }
  if ((match = host.match(/^([a-z0-9_-]+)\.icims\.com$/i))) return { ats_type: 'icims', ats_identifier: match[1], source_url: url };
  if ((match = host.match(/^([a-z0-9_-]+)\.applicantpro\.com$/i))) return { ats_type: 'applicantpro', ats_identifier: match[1], source_url: url };
  if (host === 'jobs.jobvite.com' && segments[0]) return { ats_type: 'jobvite', ats_identifier: segments[0], source_url: url };
  if ((match = host.match(/^([a-z0-9_-]+)\.pinpointhq\.com$/i))) return { ats_type: 'pinpoint', ats_identifier: match[1], source_url: url };
  if ((match = host.match(/^([a-z0-9_-]+)\.applytojob\.com$/i))) return { ats_type: 'jazzhr', ats_identifier: match[1], source_url: url };
  if (host === 'careers.kula.ai' && segments[0]) return { ats_type: 'kula', ats_identifier: segments[0], source_url: url };
  if (/\.fa\.[a-z0-9-]+\.oraclecloud\.com$/i.test(host)) {
    const siteIndex = segments.findIndex((part) => part.toLowerCase() === 'sites');
    if (siteIndex >= 0 && segments[siteIndex + 1]) return { ats_type: 'oraclehcm', ats_identifier: `${host}|${segments[siteIndex + 1]}`, source_url: url };
  }
  if (host === 'recruiting.paylocity.com' && (match = parsed.pathname.match(/\/jobs\/All\/([a-f0-9-]{36})/i))) return { ats_type: 'paylocity', ats_identifier: match[1], source_url: url };
  if (/^recruiting\d*\.ultipro\.com$/.test(host) && (match = parsed.pathname.match(/^\/([^/]+)\/JobBoard\/([a-f0-9-]+)/i))) return { ats_type: 'ukg', ats_identifier: `${host}|${match[1]}|${match[2]}`, source_url: url };
  if (host === 'workforcenow.adp.com' && /^[a-f0-9-]{36}$/i.test(parsed.searchParams.get('cid') || '')) return { ats_type: 'adp', ats_identifier: parsed.searchParams.get('cid'), source_url: url };
  if (host === 'recruiting.adp.com' && parsed.searchParams.get('c') && parsed.searchParams.get('d')) return { ats_type: 'adp', ats_identifier: `recruiting:${parsed.searchParams.get('c')}:${parsed.searchParams.get('d')}`, source_url: url };
  return null;
}

function detectSourceConfigurations(pages) {
  const configurations = [];
  const add = (value, evidence) => {
    if (!value?.ats_type || !value?.ats_identifier) return;
    const key = `${value.ats_type}\n${value.ats_identifier}`;
    if (!configurations.some((entry) => entry.key === key)) configurations.push({ ...value, key, evidence });
  };

  for (const page of pages) {
    add(detectFromUrl(page.url), { kind: 'page_url', url: page.url });
    const links = pageLinks(page.html, page.url);
    for (const link of links) add(detectFromUrl(link.url), { kind: 'official_page_link', page: page.url, url: link.url, text: link.text });

    const lower = String(page.html || '').toLowerCase();
    const host = normalizedHost(page.url);
    if (/teamtailor|ttcdn|data-teamtailor/.test(lower)) add({ ats_type: 'teamtailor', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'teamtailor', page: page.url });
    if (/phenompeople|phenom people|\/widgets["'?<\s]/.test(lower)) add({ ats_type: 'phenom', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'phenom', page: page.url });
    if (/talentbrew|radancy/.test(lower)) add({ ats_type: 'talentbrew', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'talentbrew/radancy', page: page.url });
    if (/clinchtalent|clinch\.co/.test(lower)) add({ ats_type: 'clinchtalent', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'clinchtalent', page: page.url });
    if (/successfactors|career site builder|sap\.com\/products\/human-resources-hcm/.test(lower)) add({ ats_type: 'successfactors', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'successfactors', page: page.url });
    if (/pinpointhq|postings\.json/.test(lower)) add({ ats_type: 'pinpoint', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'pinpoint', page: page.url });
    const eightfold = String(page.html || '').match(/[?&]domain=([a-z0-9.-]+)/i);
    if (/eightfold\.ai|eightfold/.test(lower) && eightfold) add({ ats_type: 'eightfold', ats_identifier: `${host}|${eightfold[1]}`, source_url: page.url }, { kind: 'page_marker', marker: 'eightfold-domain', page: page.url });
    if (/drupal-settings-json|drupal\.js/.test(lower) && /\/jobs?\/|job search|search jobs/.test(lower)) add({ ats_type: 'drupalcareers', ats_identifier: host, source_url: page.url }, { kind: 'page_marker', marker: 'drupal-careers', page: page.url });
    if (/"@type"\s*:\s*"jobposting"/i.test(page.html || '')) add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'structured_job_data', marker: 'JobPosting', page: page.url });
    try {
      const parsed = parseCareersPage(page.html, page.url);
      if (parsed.jobs.some((job) => titleLooksRelevant(job.title) && ['current', 'likely_current'].includes(job.status))) {
        add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'bounded_static_jobs', marker: 'custom_html', page: page.url });
      }
    } catch { /* Detection continues through platform-specific evidence. */ }
  }
  return configurations;
}

function fallbackArtifacts(pages) {
  const feeds = [];
  const sitemaps = [];
  let structuredJobData = false;
  for (const page of pages) {
    if (/"@type"\s*:\s*"jobposting"/i.test(page.html || '')) structuredJobData = true;
    for (const link of pageLinks(page.html, page.url)) {
      if (/rss|atom|feed/i.test(`${link.type} ${link.rel} ${link.url}`)) feeds.push(link.url);
      if (/sitemap(?:_index)?\.xml/i.test(link.url)) sitemaps.push(link.url);
    }
  }
  return { structured_job_data: structuredJobData, feeds: [...new Set(feeds)].slice(0, 20), sitemaps: [...new Set(sitemaps)].slice(0, 20) };
}

function sameCompanyDomain(a, b) {
  return registrableDomain(a) && registrableDomain(a) === registrableDomain(b);
}

function companyIdentityEvidence(companyName, page) {
  const normalize = (value) => String(value || '').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  const compactName = normalize(companyName).replace(/(?:incorporated|corporation|company|holdings|limited|inc|corp|llc|ltd|plc|group)$/g, '');
  const hostLabel = normalize(registrableDomain(page.url)?.split('.')[0]);
  const $ = cheerio.load(String(page.html || ''));
  const pageText = normalize(`${$('title').text()} ${$('meta[property="og:site_name"]').attr('content') || ''} ${$('body').text().slice(0, 100_000)}`);
  const tokens = String(companyName || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3 && !/^(the|and|inc|corp|llc|ltd|company|group|holdings)$/.test(token)) || [];
  const hostnameMatch = compactName.length >= 4 && hostLabel.length >= 4 && (hostLabel.includes(compactName) || compactName.includes(hostLabel));
  const textMatch = compactName.length >= 4 && pageText.includes(compactName);
  const tokenMatches = tokens.filter((token) => pageText.includes(token));
  return { ok: hostnameMatch || textMatch || (tokens.length > 0 && tokenMatches.length >= Math.min(2, tokens.length)), hostname_match: hostnameMatch, text_match: textMatch, token_matches: tokenMatches.slice(0, 10) };
}

async function resolveOfficialSource(signal, { readPage = fetchDocument, maxCareerPages = 6 } = {}) {
  const officialInput = signal.company_website || signal.company_url || (signal.company_domain ? `https://${signal.company_domain}` : null);
  if (!officialInput) throw Object.assign(new Error('No official company domain/website evidence in the signal'), { code: 'NEEDS_OFFICIAL_DOMAIN' });
  const officialUrl = cleanUrl(officialInput);
  if (!officialUrl) throw Object.assign(new Error('Invalid official company URL'), { code: 'BAD_OFFICIAL_URL' });

  const home = await readPage(officialUrl);
  if (!sameCompanyDomain(officialUrl, home.url)) throw Object.assign(new Error('Official URL redirected to a different registrable domain'), { code: 'OFFICIAL_DOMAIN_MISMATCH' });
  const identityEvidence = companyIdentityEvidence(signal.company_name, home);
  if (!identityEvidence.ok) throw Object.assign(new Error('Official website content/domain did not corroborate the candidate company identity'), { code: 'COMPANY_IDENTITY_MISMATCH', evidence: { official_url: home.url, identity: identityEvidence } });
  const links = pageLinks(home.html, home.url);
  const linkedUrls = new Set(links.map((link) => link.url.replace(/\/$/, '')));
  const explicit = [signal.careers_url, signal.job_url, signal.source_url].map((url) => cleanUrl(url)).filter(Boolean);
  const trustedExplicit = explicit.filter((url) => sameCompanyDomain(url, home.url) || linkedUrls.has(url.replace(/\/$/, '')));
  const careerLinks = links
    .filter((link) => CAREER_TEXT.test(link.text) || CAREER_TEXT.test(new URL(link.url).pathname) || ATS_HOST.test(link.url))
    .map((link) => link.url);
  const homeIsCareersPage = CAREER_TEXT.test(new URL(home.url).pathname) || /"@type"\s*:\s*"jobposting"/i.test(home.html || '');
  const targets = [...new Set([...trustedExplicit, ...careerLinks])].slice(0, maxCareerPages);
  if (homeIsCareersPage) targets.unshift(home.url);

  // Some verified official sites do not expose Careers in server-rendered homepage HTML.
  // Probe only a small set of conventional same-domain paths after company identity is proven.
  if (!targets.length) {
    const base = new URL(home.url);
    for (const path of ['/careers', '/jobs', '/careers/', '/jobs/']) {
      if (targets.length >= maxCareerPages) break;
      targets.push(new URL(path, base.origin).href);
    }
  }

  const pages = [{ ...home, role: homeIsCareersPage ? 'careers' : 'official_home' }];
  const failures = [];
  for (const target of targets) {
    if (target.replace(/\/$/, '') === home.url.replace(/\/$/, '')) continue;
    try {
      const page = await readPage(target);
      pages.push({ ...page, role: 'careers', linked_from: home.url });
    } catch (error) {
      failures.push({ url: target, error: error.message });
    }
  }
  if (pages.length === 1 && !homeIsCareersPage) throw Object.assign(new Error('Official site did not expose or resolve a careers/jobs page'), {
    code: 'NO_OFFICIAL_CAREERS_LINK', evidence: { official_url: home.url, attempted_pages: targets, failures },
  });
  const configurations = detectSourceConfigurations(pages.filter((page) => page.role === 'careers'));
  const fallback = fallbackArtifacts(pages.filter((page) => page.role === 'careers'));
  if (!configurations.length) throw Object.assign(new Error('No supported or safely extractable source detected on official careers pages'), {
    code: 'UNSUPPORTED_SOURCE', evidence: { official_url: home.url, identity: identityEvidence, attempted_pages: targets, failures, fallback }, pages,
  });
  return {
    official_url: home.url,
    official_domain: registrableDomain(home.url),
    careers_pages: pages.filter((page) => page.role === 'careers').map((page) => page.url),
    pages,
    configurations,
    evidence: { official_url: home.url, identity: identityEvidence, official_link_targets: targets, fetch_failures: failures, fallback },
  };
}

module.exports = {
  cleanUrl,
  normalizedHost,
  registrableDomain,
  pageLinks,
  detectFromUrl,
  detectSourceConfigurations,
  fallbackArtifacts,
  companyIdentityEvidence,
  resolveOfficialSource,
  fetchDocument,
};
