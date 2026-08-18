// Ashby Job Postings API adapter
//
// Public, unauthenticated endpoint — no signup, no API key.
// Docs: https://developers.ashbyhq.com/reference/jobpostingapi
//
// You only need the company's Ashby job board name, which is the slug in
// their public job board URL, e.g. for https://jobs.ashbyhq.com/ashby
// the job board name is "ashby".

const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";

/**
 * Fetch all currently published jobs for one employer's Ashby job board.
 * @param {string} jobBoardName - e.g. "ashby"
 * @returns {Promise<Array>} raw Ashby job posting objects
 */
async function fetchAshbyJobs(jobBoardName) {
  const url = `${BASE_URL}/${jobBoardName}?includeCompensation=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ashby fetch failed for "${jobBoardName}": ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.jobs || [];
}

/**
 * Convert one raw Ashby job posting into ROOK's canonical job shape.
 */
function normalizeAshbyJob(raw, employer) {
  const comp = raw.compensation?.summaryComponents
    ?.map((c) => c.summaryText)
    .filter(Boolean)
    .join(" · ");

  return {
    source_job_id: raw.id,
    employer_id: employer.id,
    source_type: "ashby",
    source_url: raw.jobUrl,
    application_url: raw.applyUrl || raw.jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: raw.descriptionHtml || null,
    description_text: stripHtml(raw.descriptionHtml || ""),
    location_raw: raw.location || "",
    employment_type: raw.employmentType || null,
    compensation_text: comp || null,
    date_posted: raw.publishedAt ? raw.publishedAt.slice(0, 10) : null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { fetchAshbyJobs, normalizeAshbyJob };
