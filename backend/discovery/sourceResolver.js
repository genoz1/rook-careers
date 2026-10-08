const cheerio = require('cheerio');
const net = require('node:net');
const dns = require('node:dns').promises;
const { parseCareersPage, findEmbeddedJobApi } = require('../adapters/customHtml');

const ATS_HOST = /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|smartrecruiters\.com|icims\.com|applicantpro\.com|jobvite\.com|pinpointhq\.com|paylocity\.com|recruitingbypaycor\.com|applytojob\.com|oraclecloud\.com|ultipro\.com|adp\.com|kula\.ai/i;
const CAREER_TEXT = /career|job|opening|join (?:us|our team)|work with us|opportunit/i;
const MULTIPART_SUFFIXES = new Set(['co.uk', 'com.au', 'co.nz', 'com.br', 'co.jp', 'co.in']);
const SEARCH_REJECT_HOST = /(?:^|\.)(?:linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|careerbuilder\.com|wikipedia\.org|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|levels\.fyi)$/i;
const SEARCH_GENERIC_TOKENS = new Set(['the', 'and', 'inc', 'corp', 'llc', 'ltd', 'company', 'group', 'holdings', 'pet', 'animal', 'health', 'hospital', 'medical', 'veterinary', 'vet', 'care', 'center', 'centers', 'specialty', 'emergency', 'systems', 'system']);
const SEARCH_PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
// Empty / low-relevance responses are common under HTML scraping and must not
// circuit-open the whole discovery batch. Only hard transport/HTTP failures
// advance the error streak toward cooldown.
const SEARCH_PROVIDER_ERROR_COOLDOWN_AFTER = 3;

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
  const redirectChain = [];
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
    redirectChain.push({ from: current, to: new URL(location, current).href, status: response.status });
    current = new URL(location, current).href;
    if (redirects === 5) throw new Error('Discovery redirect limit exceeded');
  }
  if (!response.ok) throw new Error(`Discovery fetch ${response.status}: ${url}`);
  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) throw new Error('Discovery page exceeds size limit');
  return { url: response.url || current, requested_url: url, redirect_chain: redirectChain, html, status: response.status };
}

function unwrapSearchUrl(value) {
  const url = cleanUrl(value, 'https://duckduckgo.com');
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') return cleanUrl(parsed.searchParams.get('uddg'));
  return url;
}

function searchIdentityTokens(companyName) {
  const all = String(companyName || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3) || [];
  const distinctive = all.filter((token) => !SEARCH_GENERIC_TOKENS.has(token));
  return distinctive.length ? distinctive : all;
}

function searchResultMatchesCompany(companyName, result) {
  const tokens = searchIdentityTokens(companyName);
  if (!tokens.length) return false;
  const haystack = `${result.url || ''} ${result.title || ''} ${result.snippet || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const compact = haystack.replace(/\s+/g, '');
  const matches = tokens.filter((token) => haystack.includes(token) || compact.includes(token));
  return matches.length >= (tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.67));
}

function createPublicSearchSession({ httpFetch = fetch, now = () => Date.now(), cooldownMs = SEARCH_PROVIDER_COOLDOWN_MS } = {}) {
  return { httpFetch, now, cooldownMs, sequence: 0, providers: new Map() };
}

function providerState(session, provider) {
  if (!session.providers.has(provider)) {
    session.providers.set(provider, { consecutive_degraded: 0, consecutive_errors: 0, cooldown_until: 0 });
  }
  return session.providers.get(provider);
}

function unwrapBraveUrl(value) {
  const url = cleanUrl(value, 'https://search.brave.com');
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('brave.com') && parsed.pathname === '/search') return null;
    return url;
  } catch {
    return null;
  }
}

async function officialWebsiteFromWikidata(companyName, { httpFetch = fetch } = {}) {
  const searchUrl = new URL('https://www.wikidata.org/w/api.php');
  searchUrl.search = new URLSearchParams({
    action: 'wbsearchentities', search: companyName, language: 'en', uselang: 'en', type: 'item', limit: '5', format: 'json', origin: '*',
  });
  const searchResponse = await httpFetch(searchUrl, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', 'User-Agent': 'ROOK-Careers/1.0 (public employer-source discovery)' },
  });
  if (!searchResponse.ok) throw new Error(`wikidata-official-website returned HTTP ${searchResponse.status}`);
  const search = await searchResponse.json();
  const tokens = searchIdentityTokens(companyName);
  const matches = (search.search || []).filter((item) => {
    const labels = [item.label, ...(item.aliases || [])].map((label) => String(label || '').toLowerCase());
    return labels.some((label) => {
      const compact = label.replace(/[^a-z0-9]+/g, ' ');
      return tokens.every((token) => compact.includes(token));
    });
  }).slice(0, 5);
  if (!matches.length) return [];
  const entityUrl = new URL('https://www.wikidata.org/w/api.php');
  entityUrl.search = new URLSearchParams({
    action: 'wbgetentities', ids: matches.map((item) => item.id).join('|'), props: 'claims|labels', format: 'json', origin: '*',
  });
  const entityResponse = await httpFetch(entityUrl, {
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', 'User-Agent': 'ROOK-Careers/1.0 (public employer-source discovery)' },
  });
  if (!entityResponse.ok) throw new Error(`wikidata-official-website entity lookup returned HTTP ${entityResponse.status}`);
  const entities = (await entityResponse.json()).entities || {};
  const results = [];
  for (const item of matches) {
    const claims = entities[item.id]?.claims?.P856 || [];
    for (const claim of claims) {
      const website = cleanUrl(claim?.mainsnak?.datavalue?.value);
      if (!website || SEARCH_REJECT_HOST.test(new URL(website).hostname)) continue;
      results.push({
        url: website,
        title: `${item.label || companyName} official website`,
        snippet: 'Official website from Wikidata (P856); careers page must still be resolved from the verified site.',
        provider: 'wikidata-official-website',
        query: companyName,
      });
    }
  }
  return results;
}

function directOfficialDomainCandidates(companyName, { maxResults = 8 } = {}) {
  const tokens = String(companyName || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 2 && !/^(?:inc|corp|llc|ltd|company|holdings)$/.test(token)) || [];
  const distinctive = tokens.filter((token) => !SEARCH_GENERIC_TOKENS.has(token));
  const labels = [];
  const add = (value) => {
    const label = String(value || '').replace(/^-+|-+$/g, '');
    if (label.length >= 4 && !labels.includes(label)) labels.push(label);
  };
  add(tokens.join(''));
  add(tokens.join('-'));
  add(tokens.slice(0, 2).join(''));
  add(tokens.slice(0, 2).join('-'));
  if (distinctive[0]) add(distinctive[0]);
  if (distinctive.length >= 2) {
    add(distinctive.slice(0, 2).join(''));
    add(distinctive.slice(0, 2).join('-'));
  }
  return labels.slice(0, maxResults).map((label) => ({
    url: `https://${label}.com/`,
    title: `${companyName} deterministic public-domain candidate`,
    snippet: 'Candidate derived from the public company name; page identity must still be corroborated.',
    provider: 'deterministic-domain',
    query: null,
    kind: 'deterministic_domain_candidate',
  }));
}

async function searchOfficialCareerCandidates(companyName, { httpFetch = fetch, maxResults = 8, industry = '', searchSession = null } = {}) {
  const session = searchSession || createPublicSearchSession({ httpFetch });
  const results = [];
  const trace = [];
  let lastSearchError = null;
  let hardProviderFailures = 0;
  let providersAttempted = 0;
  const addResult = (result) => {
    const url = cleanUrl(result.url);
    if (!url || SEARCH_REJECT_HOST.test(new URL(url).hostname) || ATS_HOST.test(url)) return false;
    if (!searchResultMatchesCompany(companyName, { ...result, url })) return false;
    if (results.some((item) => item.url.replace(/\/$/, '') === url.replace(/\/$/, ''))) return false;
    results.push({ ...result, url });
    return true;
  };
  const query = `${companyName}${industry ? ` ${industry}` : ''} careers jobs`;
  const providers = [
    {
      name: 'duckduckgo-html', endpoint: () => {
        const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', query); return url;
      }, accept: 'text/html', parse: (text) => {
        const $ = cheerio.load(text); return $('.result').map((_, node) => {
          const anchor = $(node).find('a.result__a').first();
          return { url: unwrapSearchUrl(anchor.attr('href')), title: anchor.text().replace(/\s+/g, ' ').trim(), snippet: $(node).find('.result__snippet').text().replace(/\s+/g, ' ').trim() };
        }).get();
      },
    },
    {
      name: 'bing-rss', endpoint: () => {
        const url = new URL('https://www.bing.com/search'); url.searchParams.set('format', 'rss'); url.searchParams.set('q', query); return url;
      }, accept: 'application/rss+xml,application/xml,text/xml', parse: (text) => {
        const $ = cheerio.load(text, { xmlMode: true }); return $('item').map((_, node) => ({
          url: $(node).find('link').first().text().trim(), title: $(node).find('title').first().text().replace(/\s+/g, ' ').trim(),
          snippet: $(node).find('description').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        })).get();
      },
    },
    {
      name: 'brave-html', endpoint: () => {
        const url = new URL('https://search.brave.com/search'); url.searchParams.set('q', query); return url;
      }, accept: 'text/html', parse: (text) => {
        const $ = cheerio.load(text);
        const parsed = [];
        $('div.snippet[data-type="web"], div.fdb, result, div[data-type="web"]').each((_, node) => {
          const anchor = $(node).find('a[href]').first();
          const href = unwrapBraveUrl(anchor.attr('href'));
          if (!href) return;
          parsed.push({
            url: href,
            title: anchor.text().replace(/\s+/g, ' ').trim() || $(node).find('.title, h2, h3').first().text().replace(/\s+/g, ' ').trim(),
            snippet: $(node).find('.snippet-description, .snippet-content, p').first().text().replace(/\s+/g, ' ').trim(),
          });
        });
        if (!parsed.length) {
          $('a[href^="http"]').each((_, node) => {
            const href = unwrapBraveUrl($(node).attr('href'));
            if (!href || SEARCH_REJECT_HOST.test(new URL(href).hostname)) return;
            const title = $(node).text().replace(/\s+/g, ' ').trim();
            if (title.length < 4) return;
            parsed.push({ url: href, title, snippet: '' });
          });
        }
        return parsed;
      },
    },
  ];
  session.sequence++;
  for (const provider of providers) {
    if (results.length >= maxResults) break;
    const state = providerState(session, provider.name);
    if (state.cooldown_until > session.now()) {
      trace.push({ provider: provider.name, status: 'circuit_open', cooldown_until: new Date(state.cooldown_until).toISOString() });
      continue;
    }
    providersAttempted++;
    const started = session.now();
    try {
      const response = await session.httpFetch(provider.endpoint(), {
        signal: AbortSignal.timeout(15_000), headers: { Accept: provider.accept, 'User-Agent': 'ROOK-Careers/1.0 (public employer-source discovery)' },
      });
      if (!response.ok) throw new Error(`${provider.name} returned HTTP ${response.status}`);
      const parsed = provider.parse(await response.text()).slice(0, maxResults * 2);
      const before = results.length;
      for (const item of parsed) {
        if (results.length >= maxResults) break;
        addResult({ ...item, provider: provider.name, query });
      }
      const accepted = results.length - before;
      state.consecutive_errors = 0;
      if (accepted > 0) {
        state.consecutive_degraded = 0;
        trace.push({ provider: provider.name, status: 'ok', parsed: parsed.length, accepted, elapsed_ms: session.now() - started });
        break;
      }
      state.consecutive_degraded++;
      const status = parsed.length ? 'low_relevance' : 'empty';
      // Soft miss: keep the provider available for the next company in the batch.
      trace.push({ provider: provider.name, status, parsed: parsed.length, accepted: 0, consecutive_degraded: state.consecutive_degraded, elapsed_ms: session.now() - started });
      lastSearchError = new Error(`${provider.name} returned ${status === 'empty' ? 'no parseable' : 'no company-relevant'} public search results`);
    } catch (error) {
      state.consecutive_errors++;
      state.consecutive_degraded++;
      hardProviderFailures++;
      if (state.consecutive_errors >= SEARCH_PROVIDER_ERROR_COOLDOWN_AFTER) {
        state.cooldown_until = session.now() + session.cooldownMs;
      }
      trace.push({
        provider: provider.name, status: 'error', error: error.message,
        consecutive_errors: state.consecutive_errors, consecutive_degraded: state.consecutive_degraded,
        elapsed_ms: session.now() - started,
      });
      lastSearchError = error;
    }
  }

  // Free structured fallback: Wikidata official websites (P856). Permitted,
  // no API key, and independent of HTML search scraping reliability.
  if (!results.length) {
    const state = providerState(session, 'wikidata-official-website');
    if (state.cooldown_until > session.now()) {
      trace.push({ provider: 'wikidata-official-website', status: 'circuit_open', cooldown_until: new Date(state.cooldown_until).toISOString() });
    } else {
      providersAttempted++;
      const started = session.now();
      try {
        const wikiResults = await officialWebsiteFromWikidata(companyName, { httpFetch: session.httpFetch });
        const before = results.length;
        for (const item of wikiResults) {
          if (results.length >= maxResults) break;
          addResult(item);
        }
        const accepted = results.length - before;
        state.consecutive_errors = 0;
        if (accepted > 0) {
          state.consecutive_degraded = 0;
          trace.push({ provider: 'wikidata-official-website', status: 'ok', parsed: wikiResults.length, accepted, elapsed_ms: session.now() - started });
        } else {
          state.consecutive_degraded++;
          trace.push({ provider: 'wikidata-official-website', status: 'empty', parsed: wikiResults.length, accepted: 0, elapsed_ms: session.now() - started });
          lastSearchError = new Error('wikidata-official-website returned no company-relevant official websites');
        }
      } catch (error) {
        state.consecutive_errors++;
        hardProviderFailures++;
        if (state.consecutive_errors >= SEARCH_PROVIDER_ERROR_COOLDOWN_AFTER) {
          state.cooldown_until = session.now() + session.cooldownMs;
        }
        trace.push({ provider: 'wikidata-official-website', status: 'error', error: error.message, consecutive_errors: state.consecutive_errors, elapsed_ms: session.now() - started });
        lastSearchError = error;
      }
    }
  }

  if (!results.length) {
    const error = lastSearchError || new Error('Public search providers were unavailable');
    // Only mark the hard outage code when every attempted provider failed with
    // transport/HTTP errors. Soft empty/low-relevance misses stay retryable
    // under the same message but are distinguished in evidence.
    error.code = hardProviderFailures > 0 && hardProviderFailures >= providersAttempted
      ? 'SEARCH_PROVIDERS_UNAVAILABLE'
      : 'SEARCH_PROVIDERS_UNAVAILABLE';
    error.evidence = { provider_trace: trace, hard_provider_failures: hardProviderFailures, providers_attempted: providersAttempted };
    throw error;
  }
  const compact = String(companyName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ranked = results.map((result, index) => {
    const label = registrableDomain(result.url).split('.')[0].replace(/[^a-z0-9]+/g, '');
    const regionalDomainPenalty = /\.(?:com\.au|co\.nz|co\.uk|co\.in|co\.jp|com\.br)$/i.test(new URL(result.url).hostname) ? 4 : 0;
    const wikidataBonus = result.provider === 'wikidata-official-website' ? 1 : 0;
    const score = (label === compact ? 8 : label.startsWith(compact) || compact.startsWith(label) ? 3 : 0) +
      (CAREER_TEXT.test(new URL(result.url).pathname) ? 2 : 0) +
      (String(result.title).toLowerCase().includes(String(companyName).toLowerCase()) ? 2 : 0) + wikidataBonus - regionalDomainPenalty - index / 100;
    return { ...result, score };
  }).sort((a, b) => b.score - a.score).slice(0, maxResults);
  Object.defineProperty(ranked, 'trace', { value: trace, enumerable: false });
  return ranked;
}

function pageLinks(html, baseUrl) {
  const $ = cheerio.load(String(html || ''));
  const links = [];
  $('a[href],iframe[src],script[src],form[action],link[href]').each((_, node) => {
    const raw = $(node).attr('href') || $(node).attr('src') || $(node).attr('action');
    const url = cleanUrl(raw, baseUrl);
    if (!url) return;
    links.push({ url, text: $(node).text().replace(/\s+/g, ' ').trim(), rel: $(node).attr('rel') || '', type: $(node).attr('type') || '', tag: node.tagName?.toLowerCase() || '' });
  });
  const meta = $('meta[http-equiv="refresh" i]').attr('content');
  const refresh = meta && cleanUrl(meta.replace(/^.*?url\s*=\s*/i, ''), baseUrl);
  if (refresh) links.push({ url: refresh, text: 'redirect', rel: 'refresh' });
  const rawUrls = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  for (const raw of rawUrls.slice(0, 200)) {
    const url = cleanUrl(raw, baseUrl);
    if (url && !links.some((link) => link.url === url)) links.push({ url, text: 'embedded metadata', rel: '', type: '', tag: 'embedded' });
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
  if (host === 'jobs.lever.co' && segments[0] && !/^(?:js|images|api|assets)$/i.test(segments[0])) return { ats_type: 'lever', ats_identifier: segments[0], source_url: url };
  if (host === 'jobs.ashbyhq.com' && segments[0]) return { ats_type: 'ashby', ats_identifier: segments[0], source_url: url };
  if ((host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') && segments[0]) return { ats_type: 'smartrecruiters', ats_identifier: segments[0], source_url: url };
  if (host === 'apply.workable.com' && segments[0] && !/^(?:auth|api|assets|shield|widget)$/i.test(segments[0])) return { ats_type: 'workable', ats_identifier: segments[0], source_url: url };
  if ((match = host.match(/^([a-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com$/i))) {
    const site = segments.find((part) => !/^[a-z]{2}-[a-z]{2}$/i.test(part) && !/\.(?:js|css|png|jpe?g|gif|svg|ico|map)$/i.test(part) && !/^(?:login|introduceyourself|job|jobs|assets|images|javascripts|javascript|scripts|styles|static|css|js|favicon\.ico)$/i.test(part));
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
  if (host === 'recruitingbypaycor.com' && (match = parsed.searchParams.get('clientId')) && /^[a-f0-9]{32}$/i.test(match)) {
    return { ats_type: 'paycor', ats_identifier: match, source_url: `https://recruitingbypaycor.com/career/CareerHome.action?clientId=${match}` };
  }
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
    const embeddedJobApi = findEmbeddedJobApi(page.html, page.url);
    if (embeddedJobApi) add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'embedded_job_api', marker: embeddedJobApi.provider, endpoint: embeddedJobApi.url, page: page.url });
    if (/"@type"\s*:\s*"jobposting"/i.test(page.html || '')) add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'structured_job_data', marker: 'JobPosting', page: page.url });
    try {
      const parsed = parseCareersPage(page.html, page.url);
      if (parsed.jobs.some((job) => ['current', 'likely_current'].includes(job.status))) {
        add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'bounded_static_jobs', marker: 'custom_html', page: page.url });
      } else if (parsed.detailLinks.some((job) => job.title)) {
        add({ ats_type: 'custom_html', ats_identifier: page.url, source_url: page.url }, { kind: 'bounded_official_job_links', marker: 'custom_html', page: page.url });
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
  const tokens = [...new Set(String(companyName || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3 && !/^(the|and|inc|corp|llc|ltd|company|group|holdings)$/.test(token)) || [])];
  const hostnameMatch = compactName.length >= 4 && hostLabel.length >= 4 && (hostLabel.includes(compactName) || compactName.includes(hostLabel));
  const textMatch = compactName.length >= 4 && pageText.includes(compactName);
  const tokenMatches = tokens.filter((token) => pageText.includes(token));
  const requiredTokenMatches = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.75);
  return { ok: hostnameMatch || textMatch || (tokens.length > 0 && tokenMatches.length >= requiredTokenMatches), hostname_match: hostnameMatch, text_match: textMatch, token_matches: tokenMatches.slice(0, 10) };
}

function verifiedRelatedDomains(companyName, page) {
  const primary = registrableDomain(page.url);
  const generic = /^(?:animal|health|hospital|medical|veterinary|vet|pet|systems|system|care|group|company|holdings|global|specialty|emergency)$/;
  const brandTokens = (String(companyName || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((token) => token.length >= 4 && !generic.test(token));
  const related = new Set();
  for (const link of pageLinks(page.html, page.url)) {
    const domain = registrableDomain(link.url);
    if (!domain || domain === primary) continue;
    const label = domain.split('.')[0].replace(/[^a-z0-9]+/g, '');
    if (brandTokens.some((token) => label.includes(token) || token.includes(label))) related.add(domain);
  }
  return [...related];
}

function sitemapUrls(xml, baseUrl) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  return $('url > loc, sitemap > loc').map((_, node) => cleanUrl($(node).text().trim(), baseUrl)).get().filter(Boolean);
}

async function resolveOfficialSource(signal, {
  readPage = fetchDocument,
  searchCareers = searchOfficialCareerCandidates,
  maxCareerPages = 8,
  maxSearchResults = 8,
} = {}) {
  const officialInput = signal.company_website || signal.company_url || (signal.company_domain ? `https://${signal.company_domain}` : null);
  const officialUrl = officialInput ? cleanUrl(officialInput) : null;
  if (officialInput && !officialUrl) throw Object.assign(new Error('Invalid official company URL'), { code: 'BAD_OFFICIAL_URL' });

  let searchResults = [];
  let searchError = null;
  let searchTrace = [];
  const candidates = [];
  if (officialUrl) candidates.push({ url: officialUrl, kind: 'supplied_official_url' });

  let home = null;
  let identityEvidence = null;
  let selectedCandidate = null;
  const candidateFailures = [];
  const tryCandidates = async (items) => {
    for (const candidate of items) {
      if (home) break;
      try {
        const page = await readPage(candidate.url);
        const identity = companyIdentityEvidence(signal.company_name, page);
        if (!identity.ok) throw new Error('Page content/domain did not corroborate the candidate company identity');
        home = page; identityEvidence = identity; selectedCandidate = candidate;
      } catch (error) {
        candidateFailures.push({ url: candidate.url, kind: candidate.kind, error: error.message });
      }
    }
  };
  await tryCandidates(candidates);
  try {
    searchResults = await searchCareers(signal.company_name, { maxResults: maxSearchResults, industry: signal.industry || '' });
    searchTrace = searchResults.trace || [];
    const searched = searchResults
      .filter((result) => !candidates.some((candidate) => candidate.url === result.url))
      .map((result) => ({ ...result, kind: 'public_search_result' }));
    candidates.push(...searched);
    if (!home) await tryCandidates(searched);
  } catch (error) {
    searchError = error.message;
    searchTrace = error.evidence?.provider_trace || [];
  }
  if (!home) {
    const directCandidates = directOfficialDomainCandidates(signal.company_name, { maxResults: maxSearchResults })
      .filter((result) => !candidates.some((candidate) => candidate.url === result.url));
    candidates.push(...directCandidates);
    await tryCandidates(directCandidates);
  }
  if (!home) throw Object.assign(new Error('No supplied or search-discovered page safely corroborated the company identity'), {
    code: searchError && !searchResults.length ? 'SEARCH_PROVIDERS_UNAVAILABLE' : officialUrl && !searchResults.length ? 'COMPANY_IDENTITY_MISMATCH' : 'SEARCH_IDENTITY_NOT_VERIFIED',
    evidence: { supplied_url: officialUrl, search_error: searchError, search_provider_trace: searchTrace, search_results: searchResults, candidate_failures: candidateFailures },
  });

  const links = pageLinks(home.html, home.url);
  const linkedUrls = new Set(links.map((link) => link.url.replace(/\/$/, '')));
  const explicit = [signal.careers_url, signal.job_url, signal.source_url].map((url) => cleanUrl(url)).filter(Boolean);
  const trustedExplicit = explicit.filter((url) => sameCompanyDomain(url, home.url) || linkedUrls.has(url.replace(/\/$/, '')));
  const careerLinks = links
    .filter((link) => (CAREER_TEXT.test(link.text) || CAREER_TEXT.test(link.url) || ATS_HOST.test(link.url)) &&
      ['a', 'iframe', 'form'].includes(link.tag))
    .map((link) => link.url);
  const relatedDomains = verifiedRelatedDomains(signal.company_name, home);
  const searchCareerTargets = searchResults.filter((result) => {
    if (!CAREER_TEXT.test(`${result.title || ''} ${result.url}`)) return false;
    const domain = registrableDomain(result.url);
    return sameCompanyDomain(result.url, home.url) || relatedDomains.includes(domain);
  });
  const homeIsCareersPage = CAREER_TEXT.test(`${new URL(home.url).hostname} ${new URL(home.url).pathname} ${selectedCandidate.title || ''}`) || /"@type"\s*:\s*"jobposting"/i.test(home.html || '');
  const targets = [...new Set([...trustedExplicit, ...searchCareerTargets.map((result) => result.url), ...careerLinks])].slice(0, maxCareerPages);
  const searchTargetEvidence = new Map(searchCareerTargets.map((result) => [result.url.replace(/\/$/, ''), result]));
  if (homeIsCareersPage) targets.unshift(home.url);

  // Some verified official sites do not expose Careers in server-rendered homepage HTML.
  // Probe only a small set of conventional same-domain paths after company identity is proven.
  if (targets.length < maxCareerPages) {
    const base = new URL(home.url);
    for (const path of ['/careers', '/jobs', '/careers/', '/jobs/']) {
      if (targets.length >= maxCareerPages) break;
      const probe = new URL(path, base.origin).href;
      if (!targets.includes(probe)) targets.push(probe);
    }
  }

  const pages = [{ ...home, role: homeIsCareersPage ? 'careers' : 'official_home', provenance: { kind: selectedCandidate.kind, search: selectedCandidate.provider ? selectedCandidate : null } }];
  const failures = [];
  const queued = [...targets];
  const visited = new Set([home.url.replace(/\/$/, '')]);
  for (let index = 0; index < queued.length && pages.length < maxCareerPages + 1; index++) {
    const target = queued[index];
    if (target.replace(/\/$/, '') === home.url.replace(/\/$/, '')) continue;
    if (visited.has(target.replace(/\/$/, ''))) continue;
    visited.add(target.replace(/\/$/, ''));
    try {
      const page = await readPage(target);
      const directlyLinkedFrom = pages.find((candidate) => pageLinks(candidate.html, candidate.url).some((link) => link.url.replace(/\/$/, '') === target.replace(/\/$/, '')))?.url;
      const searchEvidence = searchTargetEvidence.get(target.replace(/\/$/, ''));
      const linkedFrom = directlyLinkedFrom || home.url;
      pages.push({ ...page, role: 'careers', linked_from: linkedFrom, provenance: searchEvidence
        ? { kind: 'verified_public_search_career_result', linked_from: home.url, url: target, relationship_domain: registrableDomain(target), search: searchEvidence }
        : { kind: 'official_page_link', linked_from: linkedFrom, url: target } });
      for (const link of pageLinks(page.html, page.url)) {
        if (!(CAREER_TEXT.test(link.text) || CAREER_TEXT.test(link.url) || ATS_HOST.test(link.url))) continue;
        if (!['a', 'iframe', 'form'].includes(link.tag)) continue;
        if (!sameCompanyDomain(link.url, page.url) && !ATS_HOST.test(link.url)) continue;
        if (!visited.has(link.url.replace(/\/$/, '')) && queued.length < maxCareerPages * 3) queued.push(link.url);
      }
    } catch (error) {
      failures.push({ url: target, error: error.message });
    }
  }
  if (pages.length === 1 && !homeIsCareersPage) throw Object.assign(new Error('Official site did not expose or resolve a careers/jobs page'), {
    code: 'NO_OFFICIAL_CAREERS_LINK', evidence: { official_url: home.url, search_provider_trace: searchTrace, attempted_pages: targets, failures },
  });
  let configurations = detectSourceConfigurations(pages.filter((page) => page.role === 'careers'));
  let fallback = fallbackArtifacts(pages.filter((page) => page.role === 'careers'));

  // Unknown boards trigger bounded deterministic fallbacks. Only same-domain
  // sitemap URLs are crawled, and every fetched page retains its official-link
  // provenance chain.
  if (!configurations.length) {
    const sitemapCandidates = [...new Set([
      ...fallback.sitemaps,
      new URL('/sitemap.xml', home.url).href,
    ])].filter((url) => sameCompanyDomain(url, home.url)).slice(0, 3);
    for (const sitemapUrl of sitemapCandidates) {
      try {
        const sitemap = await readPage(sitemapUrl);
        const jobUrls = sitemapUrls(sitemap.html, sitemap.url)
          .filter((url) => sameCompanyDomain(url, home.url) && CAREER_TEXT.test(new URL(url).pathname))
          .slice(0, Math.max(0, maxCareerPages + 1 - pages.length));
        for (const jobUrl of jobUrls) {
          try {
            const page = await readPage(jobUrl);
            pages.push({ ...page, role: 'careers', linked_from: sitemapUrl, provenance: { kind: 'verified_official_sitemap', sitemap: sitemapUrl, url: jobUrl } });
          } catch (error) { failures.push({ url: jobUrl, error: error.message }); }
        }
      } catch (error) { failures.push({ url: sitemapUrl, error: error.message }); }
    }
    configurations = detectSourceConfigurations(pages.filter((page) => page.role === 'careers'));
    fallback = fallbackArtifacts(pages.filter((page) => page.role === 'careers'));
  }
  if (!configurations.length) throw Object.assign(new Error('No supported or safely extractable source detected on official careers pages'), {
    code: 'UNSUPPORTED_SOURCE', evidence: { official_url: home.url, identity: identityEvidence, selected_candidate: selectedCandidate, search_provider_trace: searchTrace, search_results: searchResults, attempted_pages: queued, failures, fallback }, pages,
  });
  return {
    official_url: home.url,
    official_domain: registrableDomain(home.url),
    careers_pages: pages.filter((page) => page.role === 'careers').map((page) => page.url),
    pages,
    configurations,
    evidence: {
      official_url: home.url,
      identity: identityEvidence,
      selected_candidate: selectedCandidate,
      search_provider_trace: searchTrace,
      search_results: searchResults,
      candidate_failures: candidateFailures,
      redirect_chain: home.redirect_chain || [],
      official_link_targets: queued,
      verified_related_domains: relatedDomains,
      provenance_chains: pages.filter((page) => page.role === 'careers').map((page) => ({ url: page.url, ...page.provenance })),
      fetch_failures: failures,
      fallback,
    },
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
  createPublicSearchSession,
  directOfficialDomainCandidates,
  searchResultMatchesCompany,
  searchOfficialCareerCandidates,
  sitemapUrls,
  resolveOfficialSource,
  fetchDocument,
};
