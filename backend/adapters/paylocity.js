// Paylocity Recruiting career-site adapter
//
// Paylocity's bulk partner-integration API is genuinely gated (requires
// a customer-sponsored Partner Program agreement) - but that's a
// different thing from the per-customer Job Feed endpoint their own
// careers-widget calls internally, which Paylocity documents directly:
// https://recruiting.paylocity.com/Recruiting/v2/api/feed/documentation
// GET https://recruiting.paylocity.com/recruiting/v2/api/feed/jobs/{guid}
// returns real, complete JSON (title, description, location, salary,
// department, applyUrl) with no authentication - confirmed against
// Paylocity's own documented example response, not reverse-engineered.
//
// The {guid} is specific to each Paylocity customer, but conveniently
// it's directly visible in that employer's own public careers URL, e.g.
// https://recruiting.paylocity.com/recruiting/jobs/All/4bcae427-e9e7-4d6d-9772-73ef70c3a278/Adapt-Health-LLC
// so no separate discovery step is needed beyond finding that URL once.
//
// You only need the GUID itself, e.g.:
//   ats_identifier = "4bcae427-e9e7-4d6d-9772-73ef70c3a278"

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPaylocityJobs(guid) {
  const url = `https://recruiting.paylocity.com/recruiting/v2/api/feed/jobs/${guid}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Paylocity feed fetch failed for guid "${guid}": ${res.status} ${res.statusText}`);
  const data = await res.json();
  const rawJobs = data?.jobs || [];
  console.log(`    ...listed ${rawJobs.length} posting(s)`);
  return rawJobs;
}

/**
 * Convert one raw Paylocity job into ROOK's canonical job shape.
 * Field names (jobId, title, description, applyUrl, displayUrl,
 * jobLocation, salaryDescription, publishedDate) match Paylocity's own
 * documented example response directly.
 */
function normalizePaylocityJob(raw, employer) {
  const jobUrl = raw.displayUrl || raw.applyUrl;
  const loc = raw.jobLocation || {};
  const locationRaw = [loc.city, loc.state].filter(Boolean).join(", ") || loc.locationDisplayName || loc.name || "";

  return {
    source_job_id: String(raw.jobId),
    employer_id: employer.id,
    source_type: "paylocity",
    source_url: jobUrl,
    application_url: raw.applyUrl || jobUrl,
    title_original: raw.title || "",
    company_name: employer.company_name,
    description_html: raw.description || null,
    description_text: (raw.description || raw.title || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    location_raw: locationRaw,
    compensation_text: raw.salaryDescription || null,
    date_posted: raw.publishedDate || raw.createdUtc || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchPaylocityJobs, normalizePaylocityJob };
