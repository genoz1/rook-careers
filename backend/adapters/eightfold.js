// Eightfold (Eightfold.ai) career-site adapter — "SmartApply" pattern
//
// Eightfold has no public API of their own (their real API requires an
// OAuth token issued per customer) — but every Eightfold-hosted career
// site's own search box calls a separate, genuinely unauthenticated
// endpoint to render results: GET /api/apply/v2/jobs?domain={domain}.
// That's what this adapter calls directly.
//
// Confirmed against a real raw response from a live Eightfold tenant
// (Bayer) - field names (id, name, location, t_create,
// canonicalPositionUrl, job_description) are verified, not guessed.
// Meaningfully higher confidence than most other custom adapters built
// this session as a result.
//
// Eightfold actually runs TWO different endpoint patterns depending on
// which version a given employer's tenant is on — "SmartApply" (used
// here) and a newer one called "PCSX." This adapter only implements
// SmartApply, confirmed via a real, working third-party example
// (American Express's tenant). An employer on the PCSX pattern instead
// will fail here with a 404 — if that happens for a specific employer,
// it needs its own follow-up investigation into PCSX's URL structure,
// not a guess bolted on without verification.
//
// You only need the employer's Eightfold subdomain and their own
// corporate domain, joined with a pipe, e.g.:
//   ats_identifier = "aexp|aexp.com"
// (from https://aexp.eightfold.ai)

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
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

function parseEightfoldIdentifier(identifier) {
  const [subdomain, domain] = String(identifier).split("|");
  if (!subdomain || !domain) throw new Error(`Malformed Eightfold identifier "${identifier}" — expected "subdomain|domain.com"`);
  return { subdomain, domain };
}

async function fetchEightfoldJobs(identifier) {
  const { subdomain, domain } = parseEightfoldIdentifier(identifier);
  const baseUrl = `https://${subdomain}.eightfold.ai`;
  const pageSize = 50;
  let start = 0;
  const rawJobs = [];
  const maxPages = 40; // safety cap for a very large employer

  for (let page = 0; page < maxPages; page++) {
    const url = `${baseUrl}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&hl=en&start=${start}`;
    let res;
    try {
      res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    } catch {
      break;
    }
    if (!res.ok) {
      if (page === 0) throw new Error(`Eightfold SmartApply fetch failed for "${identifier}": ${res.status} ${res.statusText} — this employer may be on the newer PCSX pattern instead, needs separate investigation`);
      break;
    }
    const data = await res.json();
    const pageJobs = data?.positions || [];
    if (!Array.isArray(pageJobs) || pageJobs.length === 0) break;
    rawJobs.push(...pageJobs);
    console.log(`    ...listed ${rawJobs.length} posting(s) so far`);
    if (pageJobs.length < pageSize) break;
    start += pageSize;
  }

  const relevant = rawJobs.filter((j) => titleLooksRelevant(j.name || j.title || ""));
  console.log(`    ${relevant.length} / ${rawJobs.length} titles look relevant`);
  return relevant;
}

/**
 * Convert one raw Eightfold position into ROOK's canonical job shape.
 *
 * Field names confirmed against a real raw response (Bayer's Eightfold
 * tenant): id, name, location, t_create, canonicalPositionUrl,
 * job_description all verified directly, not guessed.
 */
function normalizeEightfoldJob(raw, employer) {
  const { subdomain } = parseEightfoldIdentifier(employer.ats_identifier);
  const jobId = raw.id || raw.job_id;
  const jobUrl = raw.canonicalPositionUrl || raw.apply_url || `https://${subdomain}.eightfold.ai/careers?pid=${jobId}`;

  return {
    source_job_id: String(jobId),
    employer_id: employer.id,
    source_type: "eightfold",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.name || raw.title || "",
    company_name: employer.company_name,
    description_html: raw.job_description || null,
    description_text: stripHtml(raw.job_description || raw.name || ""),
    location_raw: raw.location || (Array.isArray(raw.locations) ? raw.locations.join(", ") : ""),
    date_posted: raw.t_create ? new Date(raw.t_create * 1000).toISOString() : null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchEightfoldJobs, normalizeEightfoldJob };
