// Jobvite career-site scraper
//
// Jobvite's own REST API is per-customer (needs credentials issued to
// that specific employer, which this project has no way to obtain), and
// their optional public syndication feed is off by default for most
// customers — there is no reliable general-purpose public API here,
// unlike Greenhouse/Lever/Ashby. What IS reliably public: every Jobvite
// employer's own career site at jobs.jobvite.com/{company}, and
// specifically its /jobs/viewall page, which is server-rendered with a
// full, un-paginated list of every open role grouped by department —
// so this adapter scrapes that page directly, same approach as the
// existing TalentBrew adapter.
//
// Same fragility caveat as TalentBrew/ClinchTalent: if Jobvite changes
// this page's markup, the regex below can break silently. It was built
// against Jobvite's markdown-rendered page content, not raw HTML source
// (no network access to arbitrary external domains from this sandbox),
// so treat the first real ingestion run against each new Jobvite
// employer as the actual test — location parsing especially, which is
// the most template-dependent part of this page and the piece most
// likely to need adjustment.
//
// You only need the employer's Jobvite company slug, e.g.:
//   ats_identifier = "neogenomics"
// (from https://jobs.jobvite.com/neogenomics)

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

async function fetchJobviteJobs(companySlug) {
  return require('./htmlSource').fetchListings(
    `https://jobs.jobvite.com/${companySlug}/jobs/viewall`, url => url.pathname.match(new RegExp('^/' + companySlug + '/job/([^/]+)'))?.[1]
  );
}

/**
 * Convert one raw scraped Jobvite job into ROOK's canonical job shape.
 *
 * NOTE: the description-extraction regex below is a best-effort guess,
 * not verified against real raw HTML source (see file header) — the
 * piece most likely to need adjustment on the first real run.
 */
function normalizeJobviteJob(raw, employer) {
  const jobUrl = `https://jobs.jobvite.com/${employer.ats_identifier}/job/${raw.jobId}`;

  const fields = require('./htmlSource').detailFields(raw.detailHtml, '.jv-job-detail-description, .job-description', '.jv-job-detail-location');
  const descriptionHtml = fields.description;
  const locationRaw = fields.location;

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "jobvite",
    source_url: jobUrl,
    application_url: jobUrl,
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

module.exports = { fetchJobviteJobs, normalizeJobviteJob };
