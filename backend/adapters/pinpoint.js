// Pinpoint (PinpointHQ) career-site adapter
//
// Unlike most other platforms in this codebase, this one is genuinely,
// officially documented as public — Pinpoint's own developer docs
// describe postings.json as designed for exactly this kind of external
// consumption ("can be fetched client side with no CORS issues"), not
// something reverse-engineered from page markup. Meaningfully higher
// confidence than the Phenom/iCIMS/Jobvite/ApplicantPro adapters as a
// result — this is closer in spirit to Greenhouse/Lever/Ashby than to
// the scraper-style adapters.
//
// Docs: https://developers.pinpointhq.com/docs/jobs-json-endpoint
//
// You only need the employer's Pinpoint subdomain, e.g.:
//   ats_identifier = "exactech"
// (from https://exactech.pinpointhq.com)

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPinpointJobs(subdomain) {
  const url = `https://${subdomain}.pinpointhq.com/postings.json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Pinpoint fetch failed for "${subdomain}": ${res.status} ${res.statusText}`);
  const data = await res.json();
  // Docs show the top-level shape as a bare array of posting objects.
  const rawJobs = Array.isArray(data) ? data : (data?.postings || data?.data || []);
  console.log(`    ...listed ${rawJobs.length} posting(s)`);
  return rawJobs;
}

/**
 * Convert one raw Pinpoint posting into ROOK's canonical job shape.
 * Field names (title, description, htmlDescription, link, location,
 * pubDate) match Pinpoint's own documented example response.
 */
function normalizePinpointJob(raw, employer) {
  const jobUrl = raw.link || raw.url || `https://${employer.ats_identifier}.pinpointhq.com`;
  const jobId = raw.id || jobUrl.split("/").filter(Boolean).pop();

  return {
    source_job_id: String(jobId),
    employer_id: employer.id,
    source_type: "pinpoint",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: raw.htmlDescription || null,
    description_text: raw.description || raw.title,
    location_raw: raw.location || "",
    date_posted: raw.pubDate || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchPinpointJobs, normalizePinpointJob };
