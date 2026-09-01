// ApplicantPro (now rebranded "isolved Talent Acquisition") career-site
// adapter
//
// Like Phenom, ApplicantPro's public-facing careers page is itself
// powered by a genuinely public, unauthenticated JSON endpoint — it's
// just a two-step process to reach it, since each employer's numeric
// "domain_id" isn't guessable from the company name and has to be
// scraped out of their jobs page first.
//
//   Step 1: GET https://{company}.applicantpro.com/jobs/
//           → scrape the numeric domain_id out of the page
//   Step 2: GET https://{company}.applicantpro.com/core/jobs/{domain_id}
//           → returns the actual job list as JSON
//
// NOTE: this was built from a third-party reverse-engineering write-up
// of ApplicantPro's page structure, not verified against a real live
// response (no network access to arbitrary external domains from this
// sandbox) — both the domain_id extraction regex and the assumed JSON
// field names below are best-effort guesses. Treat the first real
// ingestion run against a live ApplicantPro employer as the actual
// test, and expect this adapter to need correcting sooner than
// Greenhouse/Lever/Ashby if the real response shape differs.
//
// Also worth knowing: ApplicantPro rebranded to "isolved Talent
// Acquisition" — some employers may already be migrated to a different
// domain instead of *.applicantpro.com. If a company's careers page
// doesn't resolve at that domain, check whether they've moved.
//
// You only need the employer's ApplicantPro subdomain, e.g.:
//   ats_identifier = "castlebiosciences"
// (from https://castlebiosciences.applicantpro.com/jobs/)

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant", "director"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical",
];
function titleLooksRelevant(title = "") {
  const t = title.toLowerCase();
  if (STRONG_TITLE_SIGNALS.some((k) => t.includes(k))) return true;
  const hasRoleWord = ROLE_WORDS.some((k) => t.includes(k));
  const hasDomainWord = DOMAIN_WORDS.some((k) => t.includes(k));
  return hasRoleWord && hasDomainWord;
}

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
  const res = await fetchWithTimeout(`https://${subdomain}.applicantpro.com/core/jobs/${domainId}`);
  if (!res.ok) throw new Error(`ApplicantPro fetch failed for "${subdomain}": ${res.status} ${res.statusText}`);
  const data = await res.json();
  const rawJobs = Array.isArray(data) ? data : (data?.jobs || []);
  console.log(`    ...listed ${rawJobs.length} posting(s)`);

  const relevant = rawJobs.filter((j) => titleLooksRelevant(j.title || j.job_title || ""));
  console.log(`    ${relevant.length} / ${rawJobs.length} titles look relevant`);
  return relevant;
}

/**
 * Convert one raw ApplicantPro job into ROOK's canonical job shape.
 *
 * NOTE: field names (title, id/job_id, city/state, description) are a
 * best-effort guess, not verified against a real response — see file
 * header.
 */
function normalizeApplicantProJob(raw, employer) {
  const jobId = raw.id || raw.job_id || raw.jobId;
  const title = raw.title || raw.job_title || "";
  const location = [raw.city, raw.state].filter(Boolean).join(", ") || raw.location || "";
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
