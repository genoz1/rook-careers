// Greenhouse Job Board API adapter
//
// Public, unauthenticated endpoint — no signup, no API key.
// Docs: https://developers.greenhouse.io/job-board.html
//
// You only need the company's "board token", which is the slug in their
// public careers URL, e.g. for https://job-boards.greenhouse.io/stripe
// the board token is "stripe".

const BASE_URL = "https://boards-api.greenhouse.io/v1/boards";

/**
 * Fetch all currently published jobs for one employer's Greenhouse board.
 * @param {string} boardToken - e.g. "stripe"
 * @returns {Promise<Array>} raw Greenhouse job objects
 */
async function fetchGreenhouseJobs(boardToken) {
  const url = `${BASE_URL}/${boardToken}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Greenhouse fetch failed for "${boardToken}": ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.jobs || [];
}

/**
 * Convert one raw Greenhouse job into ROOK's canonical job shape.
 * This is intentionally conservative — it fills what Greenhouse reliably
 * gives you and leaves ROOK-specific classification (industry, category,
 * normalized title, etc.) to the normalization step, not this adapter.
 */
function normalizeGreenhouseJob(raw, employer) {
  const location = raw.location?.name || "";

  return {
    source_job_id: String(raw.id),
    employer_id: employer.id,
    source_type: "greenhouse",
    source_url: raw.absolute_url,
    application_url: raw.absolute_url, // Greenhouse job pages include the Apply form
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: raw.content || "",
    description_text: stripHtml(raw.content || ""),
    location_raw: location,
    date_posted: raw.updated_at ? raw.updated_at.slice(0, 10) : null,
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

module.exports = { fetchGreenhouseJobs, normalizeGreenhouseJob };
