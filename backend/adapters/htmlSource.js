const cheerio = require('cheerio');
const { titleLooksRelevant } = require('../relevanceFilter');

function jobPosting(html) {
  const $ = cheerio.load(html);
  const visit = value => {
    if (!value || typeof value !== 'object') return null;
    if ([value['@type']].flat().includes('JobPosting')) return value;
    for (const item of Array.isArray(value) ? value : value['@graph'] || []) {
      const found = visit(item); if (found) return found;
    }
    return null;
  };
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try { const found = visit(JSON.parse($(script).text())); if (found) return found; } catch {}
  }
  return null;
}
function plain(html) { return cheerio.load(String(html || '')).text().replace(/\s+/g, ' ').trim(); }
function detailFields(html, descriptionSelector, locationSelector) {
  const $ = cheerio.load(html), ld = jobPosting(html);
  let description = ld?.description || $(descriptionSelector).first().html() || '';
  // Some boards escape the complete HTML description inside JSON-LD.
  if (/&lt;\/?(?:p|div|h\d|ul|li|br)\b/i.test(description)) description = cheerio.load(description).text();
  const locations = [ld?.jobLocation || []].flat().map(loc => {
    const a = loc.address || {};
    const country = typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry;
    return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ');
  }).filter(Boolean);
  return { description, location: locations.join(' | ') || $(locationSelector).first().text().trim(), date: ld?.datePosted || null };
}
async function getHtml(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('Source HTTP ' + res.status + ' at ' + new URL(url).hostname);
  const body = await res.text();
  if ((res.headers.get('content-type') || '').includes('json')) {
    const data = JSON.parse(body);
    if (typeof data.results !== 'string') throw new Error('Expected careers results HTML in JSON response');
    return data.results;
  }
  return body;
}
function links(html, base, identify) {
  const $ = cheerio.load(html), found = [];
  $('a[href]').each((_, a) => {
    let url; try { url = new URL($(a).attr('href'), base); } catch { return; }
    if (url.origin !== new URL(base).origin) return;
    const id = identify(url);
    const node = $(a).clone(); node.find('.sr-only,.iCIMS_AccessibleText').remove();
    const titleNode = /^(view details|learn more)/i.test(node.text().trim()) ? $(a).parent().parent().find('h2,h3,h4').first() : node;
    const title = titleNode.text().replace(/^Job Posting Title\s*/i, '').replace(/\s+/g, ' ').trim();
    if (id && title) found.push({ jobId: id, title, url: url.href });
  });
  return found;
}
function nextPage(html, base) {
  const $ = cheerio.load(html);
  const results = $('#search-results[data-ajax-url]');
  if (results.length) {
    const current = Number(results.attr('data-current-page')), total = Number(results.attr('data-total-pages'));
    if (current >= total) return null;
    const url = new URL(results.attr('data-ajax-url'), base);
    if (url.origin !== new URL(base).origin) throw new Error('Cross-origin pagination rejected');
    for (const [param, attr] of Object.entries({ RecordsPerPage:'records-per-page', SearchResultsModuleName:'search-results-module-name', SearchType:'search-type', SortCriteria:'sort-criteria', SortDirection:'sort-direction', ResultsType:'results-type', Keywords:'keywords', Location:'location', OrganizationIds:'organization-ids' })) {
      url.searchParams.set(param, results.attr('data-'+attr) || '');
    }
    url.searchParams.set('CurrentPage', String(current+1));
    url.searchParams.set('SearchFiltersModuleName', 'Search Filters');
    url.searchParams.set('IsPagination', 'True');
    return url.href;
  }
  for (const a of $('a[href]').toArray()) {
    const text = [$(a).attr('rel'), $(a).attr('aria-label'), $(a).text()].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!/\bnext\b|^show \d+ more$/i.test(text)) continue;
    const url = new URL($(a).attr('href'), base);
    if (url.origin === new URL(base).origin) return url.href;
  }
  return null;
}
async function fetchListings(start, identify, { maxPages = 100, explicitEmpty = /no (?:open |current |available |matching )?(?:jobs|positions|opportunities|results)|0 (?:jobs|positions|results)/i } = {}) {
  const all = [], ids = new Set(), visited = new Set(); let url = start, incomplete = false; const warnings = [];
  while (url) {
    if (visited.has(url) || visited.size >= maxPages) { incomplete = true; warnings.push('Pagination repeated or reached safety limit'); break; }
    visited.add(url);
    let html;
    try { html = await getHtml(url); } catch (error) { if (!all.length) throw error; incomplete = true; warnings.push('Listing: '+error.message); break; }
    const batch = links(html, url, identify);
    if (!batch.length && !explicitEmpty.test(plain(html))) {
      if (!all.length) throw new Error('Source returned HTML without recognized jobs or explicit empty results');
      incomplete = true; warnings.push('Unrecognized later listing'); break;
    }
    let added = 0;
    for (const row of batch) if (!ids.has(row.jobId)) { ids.add(row.jobId); all.push(row); added++; }
    const next = nextPage(html, url);
    if (next && !added) { incomplete = true; warnings.push('Pagination returned no new jobs'); break; }
    url = next;
  }
  const detailed = [];
  detailed.incompleteSnapshot = incomplete;
  detailed.snapshotWarnings = warnings;
  detailed.sourceListingCount = all.length;
  detailed.sourceRelevantCount = all.filter(j => titleLooksRelevant(j.title)).length;
  for (const job of all.filter(j => titleLooksRelevant(j.title))) {
    try {
      const detailHtml = await getHtml(job.url);
      detailed.push({ ...job, detailHtml });
    } catch (error) { detailed.incompleteSnapshot = true; warnings.push('Detail '+job.jobId+': '+error.message); }
  }
  return detailed;
}
module.exports = { jobPosting, detailFields, plain, getHtml, links, nextPage, fetchListings };
