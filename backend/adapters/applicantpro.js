// ApplicantPro public board adapter, verified against current Medgene and Castle
// boards. The JSON endpoint requires serialized getParams, even when empty.
const { titleLooksRelevantWithDiagnostics: titleLooksRelevant } = require('../titleFilterDiagnostics');

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

async function fetchDomainId(subdomain) {
  const res = await fetchWithTimeout(`https://${subdomain}.applicantpro.com/jobs/`);
  if (!res.ok) throw new Error(`Could not load ApplicantPro jobs page for "${subdomain}": ${res.status}`);
  const html = await res.text();
  const match = html.match(/domain_id["':=]+(\d+)/i) || html.match(/\/core\/jobs\/(\d+)/i);
  if (!match) throw new Error(`Could not find a domain_id on "${subdomain}" — this employer may not actually be on ApplicantPro, or may have migrated to isolved's new domain`);
  return match[1];
}

async function fetchApplicantProJobs(subdomain) {
  const domainId = await fetchDomainId(subdomain);
  const res = await fetchWithTimeout(`https://${subdomain}.applicantpro.com/core/jobs/${domainId}?getParams=%7B%7D`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ApplicantPro fetch failed: ${res.status}`);
  const response = await res.json();
  const data = response?.data;
  if (response?.success !== true || !Array.isArray(data?.jobs) || !Number.isInteger(data.jobCount)) {
    throw new Error('ApplicantPro returned an unexpected response shape');
  }
  const { getHtml, jobPosting } = require('./htmlSource');
  const jobs = [], seen = new Set();
  jobs.incompleteSnapshot = data.jobCount !== data.jobs.length;
  jobs.snapshotWarnings = jobs.incompleteSnapshot ? ['Listing count does not match official total'] : [];
  jobs.sourceListingCount = data.jobs.length;
  for (const raw of data.jobs) {
    if (!raw.id || typeof raw.title !== 'string') throw new Error('ApplicantPro listing missing stable identity or title');
    if (seen.has(String(raw.id))) { jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push('Duplicate source ID'); continue; }
    seen.add(String(raw.id));
    if (!titleLooksRelevant(stripHtml(raw.title), raw)) continue;
    try {
      const url = new URL(raw.jobUrl);
      if (url.origin !== `https://${subdomain}.applicantpro.com`) throw new Error('Unverified cross-origin detail URL');
      const ld = jobPosting(await getHtml(url.href));
      if (!ld?.description || !ld.title) throw new Error('Detail is missing a structured job description');
      jobs.push({ ...raw, title: stripHtml(raw.title), description: ld.description, date_posted: ld.datePosted, url: url.href });
    } catch (error) {
      jobs.incompleteSnapshot = true; jobs.snapshotWarnings.push(`Detail ${raw.id}: ${error.message}`);
    }
  }
  return jobs;
}

/**
 * Convert one raw ApplicantPro job into ROOK's canonical job shape.
 *
 * Uses the verified board listing fields plus full JSON-LD description.
 */
function normalizeApplicantProJob(raw, employer) {
  const jobId = raw.id || raw.job_id || raw.jobId;
  const title = raw.title || raw.job_title || "";
  const location = raw.jobLocation || [raw.city, raw.abbreviation || raw.state, raw.iso3].filter(Boolean).join(", ") || raw.location || "";
  const jobUrl = raw.url || raw.apply_url || `https://${employer.ats_identifier}.applicantpro.com/jobs/`;

  return {
    source_job_id: String(jobId),
    employer_id: employer.id,
    source_type: "applicantpro",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: title,
    company_name: employer.company_name,
    description_html: raw.description || null,
    description_text: stripHtml(raw.description || title),
    location_raw: location,
    date_posted: raw.date_posted || raw.posted_date || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchApplicantProJobs, normalizeApplicantProJob };
