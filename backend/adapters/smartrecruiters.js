// SmartRecruiters public Posting API adapter
//
// Public, unauthenticated endpoint — no signup, no API key. Docs:
// https://developers.smartrecruiters.com/docs/endpoints
//
// You only need the company's identifier, which is the path segment in
// their careers URL: https://careers.smartrecruiters.com/{companyIdentifier}
//   e.g. for https://careers.smartrecruiters.com/MyriadGenetics1 the
//   identifier is "MyriadGenetics1" (case as it appears in the URL).
//
// Two-tier fetch, same shape as the Workday adapter: the list endpoint
// doesn't reliably include the full job description, so this fetches
// each posting's detail separately — pre-filtered by title first, same
// relevance check used everywhere else, to avoid a slow detail fetch for
// every posting on a large board.
//
// NOTE: this has not been tested against the live SmartRecruiters API
// from the environment this was written in — no network access to
// smartrecruiters.com there. Built to the documented public Posting API
// shape; treat the first real ingestion run against a SmartRecruiters
// employer as the real test, same caveat as the Workday adapter when it
// was first built.

const BASE_URL = "https://api.smartrecruiters.com/v1/companies";

const { titleLooksRelevant } = require('../relevanceFilter');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSmartRecruitersJobs(companyIdentifier) {
  const listUrl = `${BASE_URL}/${companyIdentifier}/postings`;
  const allPostings = [];
  const pageSize = 100;
  let offset = 0;
  let totalFound = Infinity;

  while (offset < totalFound) {
    const res = await fetchWithTimeout(`${listUrl}?limit=${pageSize}&offset=${offset}`);
    if (!res.ok) {
      throw new Error(`SmartRecruiters fetch failed for "${companyIdentifier}": ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (typeof data.totalFound === "number") totalFound = data.totalFound;
    allPostings.push(...(data.content || []));
    offset += pageSize;
    console.log(`    ...listed ${allPostings.length} / ${totalFound} postings`);

    if (offset > 2000) break; // safety cap, same as the Workday adapter
    if (!data.content || data.content.length === 0) break;
  }

  const relevantPostings = allPostings.filter((p) => titleLooksRelevant(p.name || ""));
  console.log(`    ${relevantPostings.length} / ${allPostings.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevantPostings.length; i++) {
    const posting = relevantPostings[i];
    try {
      const detailRes = await fetchWithTimeout(`${BASE_URL}/${companyIdentifier}/postings/${posting.id}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      detailed.push({ ...posting, detail });
    } catch {
      continue;
    }
    if ((i + 1) % 10 === 0 || i === relevantPostings.length - 1) {
      console.log(`    ...fetched details for ${i + 1} / ${relevantPostings.length}`);
    }
  }

  return detailed;
}

/**
 * Convert one raw SmartRecruiters job (list entry + detail merged) into
 * ROOK's canonical job shape.
 */
function normalizeSmartRecruitersJob(raw, employer) {
  const detail = raw.detail || {};
  const loc = detail.location || raw.location || {};
  const locationParts = [loc.city, loc.region, loc.country].filter(Boolean);
  const jobAdSections = detail.jobAd?.sections || {};
  const descriptionHtml = [
    jobAdSections.jobDescription?.text,
    jobAdSections.qualifications?.text,
  ].filter(Boolean).join(" ");

  return {
    source_job_id: String(raw.id),
    employer_id: employer.id,
    source_type: "smartrecruiters",
    source_url: raw.ref || detail.ref || `https://jobs.smartrecruiters.com/${employer.ats_identifier}/${raw.id}`,
    application_url: raw.applyUrl || raw.ref || detail.ref,
    title_original: raw.name,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.name || ""),
    location_raw: locationParts.join(", "),
    date_posted: raw.releasedDate ? String(raw.releasedDate).slice(0, 10) : null,
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

module.exports = { fetchSmartRecruitersJobs, normalizeSmartRecruitersJob };
