const cheerio = require('cheerio');
const { titleLooksRelevantWithDiagnostics: titleLooksRelevant } = require('../titleFilterDiagnostics');

const HOST = 'https://recruitingbypaycor.com';

function assertIdentifier(value) {
  const id = String(value || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('Invalid Paycor Recruiting client identifier');
  return id;
}

async function getHtml(url, { httpFetch = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== HOST) throw new Error('Paycor adapter refused an unexpected host');
  const response = await httpFetch(parsed, {
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'text/html', 'User-Agent': 'ROOK-Careers/1.0 (public job ingestion)' },
  });
  if (!response.ok) throw new Error(`Paycor Recruiting returned ${response.status}`);
  const html = await response.text();
  if (Buffer.byteLength(html) > 3_000_000) throw new Error('Paycor Recruiting page exceeds size limit');
  return html;
}

function parseBoard(html, clientId) {
  const $ = cheerio.load(String(html || ''));
  const jobs = [];
  $('a[href*="JobIntroduction.action"]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    let url;
    try { url = new URL(href, HOST); } catch { return; }
    const id = url.searchParams.get('id');
    const board = url.searchParams.get('clientId');
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (!id || board !== clientId || !title || jobs.some((job) => job.id === id)) return;
    jobs.push({ id, title, url: url.href });
  });
  const text = $.text().replace(/\s+/g, ' ').trim();
  if (!jobs.length && !/no (?:current |open |available )?(?:jobs|positions|opportunities)|0 (?:jobs|positions)/i.test(text)) {
    throw new Error('Paycor board returned no recognized postings or explicit empty state');
  }
  return jobs;
}

function parseDetail(html, listing, clientId) {
  const $ = cheerio.load(String(html || ''));
  const title = $('#gnewtonJobPosition').clone().children('b').remove().end().text().replace(/\s+/g, ' ').trim() || listing.title;
  const location = $('#gnewtonJobLocationInfo').text().replace(/\s+/g, ' ').trim();
  const description = $('#gnewtonJobDescriptionText').html();
  if (!title || !description || cheerio.load(description).text().replace(/\s+/g, ' ').trim().length < 80) throw new Error('Paycor job detail was incomplete');
  return {
    id: listing.id,
    title,
    location,
    description,
    url: `${HOST}/career/JobIntroduction.action?clientId=${clientId}&id=${listing.id}`,
    applyUrl: `${HOST}/career/SubmitResume.action?clientId=${clientId}&id=${listing.id}`,
  };
}

async function fetchPaycorJobs(identifier, options = {}) {
  const clientId = assertIdentifier(identifier);
  const boardUrl = `${HOST}/career/CareerHome.action?clientId=${clientId}`;
  const listings = parseBoard(await getHtml(boardUrl, options), clientId);
  const relevant = listings.filter((listing) => titleLooksRelevant(listing.title, listing));
  const jobs = [];
  jobs.incompleteSnapshot = false;
  jobs.snapshotWarnings = [];
  jobs.sourceListingCount = listings.length;
  jobs.sourceRelevantCount = relevant.length;
  for (const listing of relevant) {
    try { jobs.push(parseDetail(await getHtml(listing.url, options), listing, clientId)); }
    catch (error) {
      jobs.incompleteSnapshot = true;
      jobs.snapshotWarnings.push(`${listing.id}: ${error.message}`);
    }
  }
  return jobs;
}

function normalizePaycorJob(raw, employer) {
  return {
    source_job_id: String(raw.id),
    employer_id: employer.id,
    source_type: 'paycor',
    source_url: raw.url,
    application_url: raw.applyUrl || raw.url,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: raw.description,
    description_text: cheerio.load(String(raw.description || '')).text().replace(/\s+/g, ' ').trim(),
    location_raw: raw.location || '',
    industry: employer.industry || null,
    status: 'active',
    source_verified: true,
  };
}

module.exports = { assertIdentifier, parseBoard, parseDetail, fetchPaycorJobs, normalizePaycorJob };
