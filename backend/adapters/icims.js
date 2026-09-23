// iCIMS career-site scraper
//
// iCIMS has no public JSON job API at all — the real Customer/Partner
// API is OAuth-gated and issued only to iCIMS's own customers. What IS
// publicly reachable: the employer's own career-site search page at
// {company}.icims.com/jobs/search, which iCIMS itself renders as plain
// HTML (no JSON-LD, unlike some other ATSs) inside an iframe. Adding
// ?in_iframe=1 returns just that inner content without the page chrome
// around it, which is what this scrapes directly.
//
// More fragile than Greenhouse/Lever/Ashby for a few reasons: this is
// pure HTML scraping, not a documented API; iCIMS's own CSS class names
// (the "iCIMS_" prefix) are known to vary somewhat between tenant
// versions; and some iCIMS deployments sit behind Cloudflare protection
// that can block plain server-to-server requests entirely. Built from a
// third-party scraping guide's example code, not verified against a
// real live response (no network access to arbitrary external domains
// from this sandbox) — treat the first real ingestion run against a
// live iCIMS employer as the actual test, and expect this adapter
// specifically to need adjustment sooner than the API-based ones if a
// given tenant's markup doesn't match what's assumed below.
//
// You only need the employer's iCIMS subdomain, e.g.:
//   ats_identifier = "careers-bruker"
// (from https://careers-bruker.icims.com, sometimes written as
// worldwidecareers-{company} or careers-{company} depending on the
// tenant — check the employer's actual careers link for the exact
// subdomain rather than assuming the pattern.)

const { titleLooksRelevant } = require('../relevanceFilter');

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ")
    // Reported via audit: literal "&nbsp;" and encoded apostrophes were
    // showing up in public job descriptions - stripping tags alone
    // doesn't decode HTML entities, so they survived as raw text.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&hellip;/gi, "...")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // A standard desktop user-agent avoids some tenants redirecting
        // to a differently-structured mobile version.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIcimsJobs(subdomain) {
  const host = subdomain.includes('.') ? subdomain.replace(/^https?:\/\//, '').replace(/\/$/, '') : subdomain + '.icims.com';
  if (!host.endsWith('.icims.com')) {
    const rows = await require('./jibe').fetchJibeJobs(host);
    const mapped = rows.map(j => ({ jobId: String(j.req_id), title: j.title, url: j.canonical_url, jibe: j }));
    mapped.incompleteSnapshot = !!rows.incompleteSnapshot;
    return mapped;
  }
  return require('./htmlSource').fetchListings(
    `https://${host}/jobs/search?in_iframe=1`, url => url.pathname.match(/^\/jobs\/(\d+)\//)?.[1]
  );
}

/**
 * Convert one raw scraped iCIMS job into ROOK's canonical job shape.
 *
 * NOTE: the description and location extraction below are best-effort
 * guesses at iCIMS's typical detail-page structure, not verified
 * against real raw HTML (see file header) — the piece most likely to
 * need adjustment on the first real run.
 */
function normalizeIcimsJob(raw, employer) {
  const fields = raw.jibe ? { description: [raw.jibe.description, raw.jibe.responsibilities, raw.jibe.qualifications].filter(Boolean).join('\n'), location: [raw.jibe.city, raw.jibe.state, raw.jibe.country].filter(Boolean).join(', '), date: raw.jibe.create_date || null } : require('./htmlSource').detailFields(raw.detailHtml, '.iCIMS_JobContent', '.iCIMS_JobHeaderLocation');
  const descriptionHtml = fields.description;
  const locationRaw = fields.location;

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "icims",
    source_url: raw.url,
    application_url: raw.url,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: locationRaw,
    ...(raw.jibe ? { location_evidence: { source_country_code: raw.jibe.country_code || null } } : {}),
    date_posted: fields.date,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchIcimsJobs, normalizeIcimsJob };
