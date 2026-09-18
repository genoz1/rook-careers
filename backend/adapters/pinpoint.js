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
//
// CUSTOM DOMAIN SUPPORT (Sept 2026): some employers CNAME their own
// domain onto Pinpoint instead of using the branded *.pinpointhq.com
// subdomain — confirmed live for Align Technology, whose careers site is
// "Powered by" Pinpoint (footer credit + postings.json still present)
// but served at jobs.aligntech.com, not a pinpointhq.com subdomain. This
// is a reusable variation, not an Align-specific hack: any employer on a
// CNAME'd domain hits the same problem. ats_identifier now accepts
// either a bare subdomain ("exactech" → exactech.pinpointhq.com) or a
// full custom hostname ("jobs.aligntech.com", used as-is) — distinguished
// by whether the value contains a dot.

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pinpointHost(identifier) {
  return identifier.includes(".") ? identifier : `${identifier}.pinpointhq.com`;
}

async function fetchPinpointJobs(identifier) {
  const host = pinpointHost(identifier);
  const url = `https://${host}/postings.json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Pinpoint fetch failed for "${identifier}": ${res.status} ${res.statusText}`);
  const data = await res.json();
  // Docs show the top-level shape as a bare array of posting objects.
  const rawJobs = Array.isArray(data) ? data : (data?.postings ?? data?.data);
  if (!Array.isArray(rawJobs)) throw new Error("Pinpoint malformed listing response");
  console.log(`    ...listed ${rawJobs.length} posting(s)`);
  return rawJobs;
}

/**
 * Convert one raw Pinpoint posting into ROOK's canonical job shape.
 * Field names (title, description, htmlDescription, link, location,
 * pubDate) match Pinpoint's own documented example response.
 */
function normalizePinpointJob(raw, employer) {
  const jobUrl = raw.link || raw.url || `https://${pinpointHost(employer.ats_identifier)}`;
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
    location_raw: raw.location?.name || "",
    date_posted: raw.pubDate || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchPinpointJobs, normalizePinpointJob, pinpointHost };
