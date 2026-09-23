// Teamtailor career-site scraper
//
// Teamtailor's real API (api.teamtailor.com/v1) is per-tenant — each
// customer mints their own API key inside their own admin panel, and a
// key from one tenant can't read another's data, so there's no way to
// use it across many different employers. What IS usable: every
// Teamtailor customer's public career site is statically server-rendered
// (confirmed directly — 3Shape's careers.3shape.com/jobs page returns
// full job listings as plain HTML, no JavaScript execution needed),
// unlike several of the other adapters built this session.
//
// Many companies run this on their own custom domain (e.g.
// careers.3shape.com) rather than a *.teamtailor.com subdomain, so the
// identifier here is the employer's actual careers domain, not a
// guessable Teamtailor-specific slug.
//
// You only need the employer's careers domain, e.g.:
//   ats_identifier = "careers.3shape.com"

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
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTeamtailorJobs(domain) {
  return require('./htmlSource').fetchListings(
    `https://${domain}/jobs`, url => url.pathname.match(/^\/jobs\/(\d+)-/)?.[1]
  );
}

/**
 * Convert one raw scraped Teamtailor job into ROOK's canonical job shape.
 *
 * NOTE: description/location extraction is a best-effort guess at
 * Teamtailor's typical detail-page structure, not verified against raw
 * HTML source for a variety of tenants — the piece most likely to need
 * adjustment per employer, since different companies theme their career
 * pages differently even on the same underlying platform.
 */
function normalizeTeamtailorJob(raw, employer) {
  const fields = require('./htmlSource').detailFields(raw.detailHtml, '.body, [data-controller="job-description"]', '.job-location');
  const descriptionHtml = fields.description;
  const locationRaw = fields.location;

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "teamtailor",
    source_url: raw.url,
    application_url: raw.url,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: locationRaw,
    date_posted: fields.date,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchTeamtailorJobs, normalizeTeamtailorJob };
