// Workable public widget API adapter
//
// Public, unauthenticated endpoint — no signup, no API key. This is the
// same JSON feed that powers Workable-hosted careers pages and embeddable
// job widgets (distinct from Workable's authenticated v3 REST API, which
// needs a per-account bearer token and is meant for HR integrations, not
// public job aggregation).
//
// You only need the company's account slug, which is the path segment in
// their careers URL: https://apply.workable.com/{slug}/
//   e.g. for https://apply.workable.com/vanta-diagnostics/ the slug is
//   "vanta-diagnostics" — note this is NOT always the same as an account
//   ID that sometimes appears in alternate Workable URL formats
//   (jobs.workable.com/company/{accountId}/...); verify the slug against
//   the apply.workable.com/{slug}/ form specifically.
//
// NOTE: this has not been tested against the live Workable API from the
// environment this was written in — no network access to workable.com
// there. Built to the documented public widget response shape; treat the
// first real ingestion run against a Workable employer as the real test,
// same caveat as the Workday adapter when it was first built.

const BASE_URL = "https://apply.workable.com/api/v1/widget/accounts";

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all currently published jobs for one employer's Workable account,
 * including full descriptions (details=true is a single request — unlike
 * Workday/SmartRecruiters, there's no separate per-job detail fetch needed).
 * @param {string} accountSlug - e.g. "vanta-diagnostics"
 * @returns {Promise<Array>} raw Workable job objects
 */
async function fetchWorkableJobs(accountSlug) {
  const url = `${BASE_URL}/${accountSlug}?details=true`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Workable fetch failed for "${accountSlug}": ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.jobs || [];
}

/**
 * Convert one raw Workable job into ROOK's canonical job shape.
 */
function normalizeWorkableJob(raw, employer) {
  const location = raw.location?.location_str || raw.location?.city || "";
  const description = [raw.description, raw.full_description].filter(Boolean).join(" ");

  return {
    source_job_id: String(raw.id || raw.shortcode),
    employer_id: employer.id,
    source_type: "workable",
    source_url: raw.url || raw.shortlink,
    application_url: raw.application_url || raw.url || raw.shortlink,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: description || null,
    description_text: stripHtml(description || raw.title || ""),
    location_raw: location,
    date_posted: (raw.published_on || raw.created_at) ? String(raw.published_on || raw.created_at).slice(0, 10) : null,
    status: "active",
    source_verified: true,
  };
}

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

module.exports = { fetchWorkableJobs, normalizeWorkableJob };
