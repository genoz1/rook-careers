// TalentBrew (Radancy) career-site scraper
//
// Unlike Greenhouse/Lever/Ashby/Workday, TalentBrew does not expose a
// documented public JSON API — it's a server-rendered search page, so this
// adapter parses the HTML directly instead of calling a clean API. That
// makes it meaningfully more fragile than the other adapters: if an
// employer's TalentBrew theme changes, the regex patterns below can break
// silently. Treat the first real ingestion run against each new TalentBrew
// employer as a real test, and expect this one specifically to need
// occasional maintenance in a way Workday/Greenhouse/Lever/Ashby shouldn't.
//
// You only need the employer's careers-site hostname, e.g.:
//   ats_identifier = "careers.questdiagnostics.com"
//
// TalentBrew search pages can list thousands of jobs for a large employer
// (Quest alone has 2000+). To keep ingestion reasonably fast and avoid
// hammering the site, this adapter does a lightweight keyword check on the
// TITLE before fetching each job's full detail page — full descriptions
// are only fetched for postings that already look relevant, not for every
// single listing.

// Same relevance filter used in ingest.js — kept in sync with it. See the
// comment there for why this is a two-tier check rather than a flat
// keyword list.
const { titleLooksRelevant } = require('../relevanceFilter');

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ")
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

/**
 * Fetch jobs from a TalentBrew-powered careers site by scraping the
 * search-results HTML directly.
 *
 * @param {string} hostname - e.g. "careers.questdiagnostics.com"
 */

// Wraps fetch() with a timeout so one stalled request can't hang the
// entire ingestion run forever.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTalentBrewJobs(hostname) {
  const start = /^https?:/.test(hostname) ? hostname : 'https://' + hostname + '/search-jobs';
  return require('./htmlSource').fetchListings(start, url => url.pathname.match(/\/job\/[^/]+\/[^/]+\/\d+\/(\d+)\/?$/)?.[1]);
}

/**
 * Convert one raw scraped job into ROOK's canonical job shape.
 *
 * NOTE: the description-extraction regex below is a best-effort guess at
 * TalentBrew's typical markup — it has not been verified against real raw
 * HTML source (only against a text-rendered version of one page). This is
 * the piece most likely to need adjustment on the first real run.
 */
function normalizeTalentBrewJob(raw, employer) {
  const base = `https://${employer.ats_identifier}`;
  const jobUrl = raw.url || `${base}${raw.path}`;

  const fields = require('./htmlSource').detailFields(raw.detailHtml, '.job-description, .jobDescription', '.job-location');
  const descriptionHtml = fields.description;

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "talentbrew",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: fields.location,
    date_posted: fields.date,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchTalentBrewJobs, normalizeTalentBrewJob };
