// Lever Postings API adapter
//
// Public, unauthenticated endpoint — no signup, no API key.
// Docs: https://github.com/lever/postings-api
//
// You only need the company's Lever site identifier, which is the slug
// in their public postings URL, e.g. for https://jobs.lever.co/netflix
// the identifier is "netflix".

const BASE_URL = "https://api.lever.co/v0/postings";

/**
 * Fetch all currently published jobs for one employer's Lever site.
 * @param {string} siteId - e.g. "netflix"
 * @returns {Promise<Array>} raw Lever posting objects
 */
async function fetchLeverJobs(siteId) {
  const url = `${BASE_URL}/${siteId}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Lever fetch failed for "${siteId}": ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Convert one raw Lever posting into ROOK's canonical job shape.
 */
function normalizeLeverJob(raw, employer) {
  const loc = raw.categories?.location || "";
  const salary = raw.salaryRange
    ? `${raw.salaryRange.min ?? ""}-${raw.salaryRange.max ?? ""} ${raw.salaryRange.currency ?? ""}`.trim()
    : null;

  return {
    source_job_id: raw.id,
    employer_id: employer.id,
    source_type: "lever",
    source_url: raw.hostedUrl,
    application_url: raw.applyUrl || raw.hostedUrl,
    title_original: raw.text,
    company_name: employer.company_name,
    description_html: raw.descriptionPlain ? null : raw.description,
    description_text: raw.descriptionPlain || stripHtml(raw.description || ""),
    location_raw: loc,
    employment_type: raw.categories?.commitment || null,
    compensation_text: salary,
    date_posted: raw.createdAt ? new Date(raw.createdAt).toISOString().slice(0, 10) : null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { fetchLeverJobs, normalizeLeverJob };
