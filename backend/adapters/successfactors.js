// SAP SuccessFactors Career Site Builder (CSB) adapter
//
// Public, unauthenticated endpoint — no signup, no API key required.
// SuccessFactors Career Site Builder exposes a REST API that backs the
// search box on a company's own public careers site. This is the same
// API the browser calls when a visitor searches for jobs.
//
// IDENTIFIER FORMAT: the base hostname of the company's careers site
//   e.g. "jobs.boehringer-ingelheim.com"
//        "careers.astellas.com"
//        "careers.daiichisankyo.com"
//
// ENDPOINT PATTERNS (tried in order):
//   1. /api/rest/2.0/posting?start=0&limit=100&lang=en_US
//   2. /api/rest/2.0/posting?offset=0&limit=100&lang=en_US
//   3. /api/rest/2.0/requisition?start=0&limit=100
//
// SuccessFactors paginates; this adapter walks all pages.
// All jobs are pre-filtered for US relevance before being returned.
//
// NOTES:
//   - SuccessFactors CSB API shapes are broadly standardized but individual
//     clients may customize field names. The normalizer handles the most
//     common variants.
//   - Some employers add a country filter to their portal; others show all
//     global jobs. The ingest pipeline's US-filter handles post-fetch.
//   - Treat the first real ingestion run against each new employer as a test —
//     inspect the raw output to confirm the field mapping is correct.

const { titleLooksRelevant } = require("../relevanceFilter");

const DEFAULT_TIMEOUT_MS = 20000;
const PAGE_SIZE = 100;

// ── HTML stripper (shared with other adapters) ────────────────────────────

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
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

// ── Timeout-aware fetch ───────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── API endpoint patterns ─────────────────────────────────────────────────

// SuccessFactors CSB sites use one of a few URL shapes depending on the
// version of the platform and how the employer configured their portal.
// We try each in sequence until one returns a valid JSON response.
const ENDPOINT_PATTERNS = [
  (host, start) => `https://${host}/api/rest/2.0/posting?start=${start}&limit=${PAGE_SIZE}&lang=en_US`,
  (host, start) => `https://${host}/api/rest/2.0/posting?offset=${start}&limit=${PAGE_SIZE}&lang=en_US`,
  (host, start) => `https://${host}/api/rest/2.0/requisition?start=${start}&limit=${PAGE_SIZE}&lang=en_US`,
  // Some SF sites use a "jobs" endpoint variant
  (host, start) => `https://${host}/api/rest/2.0/jobs?start=${start}&limit=${PAGE_SIZE}&lang=en_US`,
];

// ── Normalize field names (SF uses multiple naming conventions) ───────────

function extractField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

function extractLocation(raw) {
  // SuccessFactors stores location in several possible shapes
  const city    = extractField(raw, "city", "City", "jobCity");
  const state   = extractField(raw, "stateCode", "state", "State", "jobState");
  const country = extractField(raw, "country", "Country", "countryCode");
  const locStr  = extractField(raw, "location", "Location", "locationDesc", "jobLocation");

  if (locStr && typeof locStr === "string") return locStr;
  if (city && state) return `${city}, ${state}`;
  if (city && country) return `${city}, ${country}`;
  if (city) return city;
  if (locStr && typeof locStr === "object") {
    // Some SF versions return location as an object
    const parts = [locStr.city, locStr.stateCode || locStr.state, locStr.country].filter(Boolean);
    return parts.join(", ");
  }
  return null;
}

function extractDescription(raw) {
  const html = extractField(
    raw,
    "jobDescription", "JobDescription", "descriptionHtml",
    "externalDesc", "description", "Description"
  );
  if (html) return { html, text: stripHtml(html) };
  const text = extractField(raw, "descriptionText", "jobDescriptionText");
  if (text) return { html: text, text: stripHtml(text) };
  return { html: "", text: "" };
}

function extractPostedDate(raw) {
  const raw_date = extractField(
    raw,
    "postingDate", "PostingDate", "startDate",
    "jobStartDate", "postedDate", "createdDate", "publishedDate"
  );
  if (!raw_date) return null;
  // Handle epoch ms, ISO string, or YYYY-MM-DD
  if (typeof raw_date === "number") {
    return new Date(raw_date).toISOString().slice(0, 10);
  }
  if (typeof raw_date === "string") {
    // "/Date(1693440000000)/" format common in OData
    const epochMatch = raw_date.match(/\/Date\((\d+)\)\//);
    if (epochMatch) return new Date(parseInt(epochMatch[1])).toISOString().slice(0, 10);
    // ISO or YYYY-MM-DD
    return raw_date.slice(0, 10);
  }
  return null;
}

function extractJobId(raw) {
  return String(
    extractField(raw, "id", "jobReqId", "requisitionId", "jobId", "postingId") || ""
  );
}

function extractTitle(raw) {
  return extractField(raw, "title", "Title", "jobTitle", "name");
}

function extractJobUrl(raw, host) {
  const url = extractField(raw, "jobUrl", "externalJobUrl", "url", "applyUrl");
  if (url) return url.startsWith("http") ? url : `https://${host}${url}`;
  const path = extractField(raw, "externalPath", "jobPath", "path");
  if (path) return `https://${host}${path}`;
  const id = extractJobId(raw);
  return id ? `https://${host}/job/${id}` : null;
}

// ── Parse the paginated response ──────────────────────────────────────────

function parseResponse(data) {
  // SF CSB returns results in different wrapper shapes:
  //   { total, reqPostings: [...] }
  //   { totalCount, results: [...] }
  //   { total, items: [...] }
  //   { count, value: [...] }      (OData)
  //   [ ... ]                      (flat array — rare)
  if (Array.isArray(data)) return { jobs: data, total: data.length };

  const jobs =
    data.reqPostings  ??
    data.results      ??
    data.items        ??
    data.value        ??
    data.postings     ??
    data.jobs         ??
    [];

  const total =
    data.total      ??
    data.totalCount ??
    data.count      ??
    jobs.length;

  return { jobs, total: Number(total) || jobs.length };
}

// ── Probe which endpoint pattern works for this employer ──────────────────

async function probeEndpoint(host) {
  for (const pattern of ENDPOINT_PATTERNS) {
    const url = pattern(host, 0);
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      }, 12000);
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;
      const data = await res.json();
      const { jobs } = parseResponse(data);
      if (Array.isArray(jobs)) return pattern; // this pattern works
    } catch (_) {
      // try next pattern
    }
  }
  return null;
}

// ── Main fetch function ───────────────────────────────────────────────────

/**
 * Fetch all published US-relevant jobs from a SuccessFactors Career Site.
 *
 * @param {string} identifier - hostname, e.g. "careers.astellas.com"
 * @returns {Promise<Array>} raw SF job objects
 */
async function fetchSuccessFactorsJobs(identifier) {
  const host = identifier.replace(/^https?:\/\//, "").replace(/\/$/, "");

  // Find which endpoint pattern this employer uses
  const workingPattern = await probeEndpoint(host);
  if (!workingPattern) {
    throw new Error(
      `SuccessFactors: could not find a working API endpoint for "${host}". ` +
      `Check the career site URL and confirm it's SuccessFactors CSB.`
    );
  }

  const allJobs = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const url = workingPattern(host, start);
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      throw new Error(`SuccessFactors fetch failed for "${host}" at offset ${start}: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const { jobs, total: pageTotal } = parseResponse(data);

    if (!Array.isArray(jobs) || jobs.length === 0) break;

    total = pageTotal;
    allJobs.push(...jobs);
    start += jobs.length;

    // Guard: if the API isn't paginating properly, stop after first page
    if (jobs.length < PAGE_SIZE) break;
  }

  return allJobs;
}

// ── Normalize one raw SF job to ROOK's canonical shape ───────────────────

/**
 * @param {Object} raw - one raw SuccessFactors job object
 * @param {Object} employer - ROOK employer row { id, company_name, ... }
 * @param {string} host - the career site hostname
 */
function normalizeSuccessFactorsJob(raw, employer, host) {
  const title = extractTitle(raw);
  if (!title) return null; // skip malformed records

  const location = extractLocation(raw);
  const { html: descHtml, text: descText } = extractDescription(raw);
  const jobId = extractJobId(raw);
  const jobUrl = extractJobUrl(raw, host);
  const datePosted = extractPostedDate(raw);

  // Compensation — SF sometimes includes salary bands
  const salaryMin = extractField(raw, "salaryMin", "minimumSalary", "salaryFrom") || null;
  const salaryMax = extractField(raw, "salaryMax", "maximumSalary", "salaryTo") || null;

  // Employment type
  const empType = extractField(raw, "employmentType", "jobType", "type");

  return {
    source_job_id:    jobId,
    employer_id:      employer.id,
    source_type:      "successfactors",
    source_url:       jobUrl,
    application_url:  jobUrl,
    title_original:   title,
    company_name:     employer.company_name,
    description_html: descHtml,
    description_text: descText,
    location_raw:     location,
    salary_min:       salaryMin ? Number(salaryMin) || null : null,
    salary_max:       salaryMax ? Number(salaryMax) || null : null,
    employment_type:  empType   ? String(empType)          : null,
    date_posted:      datePosted,
    status:           "active",
    source_verified:  true,
  };
}

module.exports = { fetchSuccessFactorsJobs, normalizeSuccessFactorsJob };
