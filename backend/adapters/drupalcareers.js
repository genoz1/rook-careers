// "Drupal careers" site scraper
//
// A distinct pattern from the other custom-site adapters here: this one
// is fully server-rendered plain HTML (confirmed directly against a real
// live page — Hologic's careers.hologic.com/en/search), no JavaScript
// execution needed at all, with simple numbered-page pagination and
// clean job detail links. Genuinely more reliable to scrape than
// Phenom/Jobvite/iCIMS/ApplicantPro precisely because there's no dynamic
// client-side rendering or session/token handling involved — what you
// fetch is what a browser would see.
//
// Still a scraper rather than an API, so the usual caveat applies: if
// the employer changes their page markup, this can break silently.
// Confirmed for Hologic specifically; other employers on what looks
// like the same underlying platform (a Drupal-based enterprise careers
// CMS) have not been individually verified — treat each new employer's
// first real ingestion run as the actual test for that employer.
//
// You only need the employer's careers domain, e.g.:
//   ats_identifier = "careers.hologic.com"
// (from https://careers.hologic.com/en/search)

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

async function fetchDrupalCareersJobs(domain) {
  const start = /^https?:/.test(domain) ? domain : 'https://' + domain + '/en/search';
  return require('./htmlSource').fetchListings(start, url => url.pathname.match(/^\/search\/(\d+)\//)?.[1]);
}

/**
 * Convert one raw scraped job into ROOK's canonical job shape.
 *
 * NOTE: description/location extraction is a best-effort guess at this
 * platform's typical detail-page structure — the piece most likely to
 * need adjustment per employer, since exact class names can vary between
 * different companies' theming of the same underlying platform.
 */
function normalizeDrupalCareersJob(raw, employer) {
  const fields = require('./htmlSource').detailFields(raw.detailHtml, '.job-description, .jobDescription, .job-detail-description', '.job-location, .basicinfo');
  const descriptionHtml = fields.description;
  const locationRaw = fields.location;

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "drupalcareers",
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

module.exports = { fetchDrupalCareersJobs, normalizeDrupalCareersJob };
