// Oracle Fusion Cloud HCM Recruiting adapter
//
// Uses the "Candidate Experience" (CE) endpoints — a genuinely public,
// unauthenticated JSON API distinct from Oracle's documented internal
// REST API (which requires real per-tenant username/password credentials
// this project has no way to obtain). The CE endpoints are what actually
// powers the public-facing job search widget any anonymous visitor uses
// — no login needed, just an arbitrary UUID sent as a tracking header.
//
// Discovered specifically because Quest Diagnostics turned out NOT to be
// on TalentBrew at all — careers.questdiagnostics.com/search-jobs is a
// mostly-static shell; the real, live listings load client-side from
// Quest's actual Oracle HCM tenant. This adapter is what finally reaches
// that real data instead of the same handful of "featured" jobs the old
// TalentBrew-style scrape kept returning.
//
// You need two pieces of information per employer:
//   domain     — the employer's Oracle HCM hostname, e.g.
//                "hdox.fa.us6.oraclecloud.com" for Quest Diagnostics.
//                Every tenant lives at {code}.fa.{datacenter}.oraclecloud.com
//                — there is no shared domain to auto-detect from, so this
//                always needs to come from the employer's actual careers URL.
//   siteNumber — the segment in /sites/{siteNumber}/jobs in that same
//                careers URL, e.g. "CX_1". If the URL uses a vanity slug
//                instead of a literal CX_* segment, the real siteNumber is
//                usually still discoverable in that page's HTML — most
//                production tenants default to "CX_1" if genuinely unclear.
//
// Store both in employers.ats_identifier as: "domain|siteNumber"
//   e.g. "hdox.fa.us6.oraclecloud.com|CX_1"
//
// CRITICAL API QUIRKS (found in third-party integration docs — Oracle
// doesn't publish this endpoint officially, so there's no official docs
// page to link):
//   - limit/offset MUST be embedded inside the "finder" query param
//     string itself, not passed as separate top-level query params —
//     Oracle silently ignores them there and every "page" returns the
//     exact same first page of results.
//   - The finder string's punctuation (; = , ") must stay LITERAL, not
//     URL-encoded — building it with a normal query-string library breaks
//     it.
//   - The response's top-level "hasMore" flag is NOT reliable for
//     pagination — it describes the outer single-item wrapper, not
//     whether more job pages exist. Paginate against TotalJobsCount
//     instead.
//
// NOTE: this has not been tested against a live Oracle HCM tenant from
// the environment this was written in — no network access there. Built
// to match a detailed third-party integration guide's exact request/
// response shape; treat the first real ingestion run as the real test,
// same caveat as every other adapter here when first built.

const crypto = require("crypto");

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant"];
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

function parseOracleIdentifier(identifier) {
  const [domain, siteNumber] = (identifier || "").split("|");
  if (!domain || !siteNumber) {
    throw new Error(
      `Malformed Oracle HCM ats_identifier "${identifier}" — expected "domain|siteNumber", e.g. "hdox.fa.us6.oraclecloud.com|CX_1"`
    );
  }
  return { domain, siteNumber };
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

function oracleHeaders() {
  return {
    "ora-irc-cx-userid": crypto.randomUUID(),
    "ora-irc-language": "en",
    "content-type": "application/vnd.oracle.adf.resourceitem+json;charset=utf-8",
  };
}

async function fetchOracleHcmJobs(identifier) {
  const { domain, siteNumber } = parseOracleIdentifier(identifier);
  const listingsPath = "/hcmRestApi/resources/latest/recruitingCEJobRequisitions";
  const pageSize = 200; // the CE API caps the finder-scoped list at 200 per request

  const allJobs = [];
  let offset = 0;
  let total = null;

  while (true) {
    // limit/offset MUST live inside the finder string — see file header.
    // Built by hand rather than via URLSearchParams so ; = , stay literal.
    const finder = `findReqs;siteNumber=${siteNumber},limit=${pageSize},offset=${offset}`;
    const expand = "requisitionList.workLocation,requisitionList.otherWorkLocations,requisitionList.secondaryLocations";
    const url = `https://${domain}${listingsPath}?onlyData=true&expand=${expand}&finder=${finder}`;

    const res = await fetchWithTimeout(url, { headers: oracleHeaders() });
    if (!res.ok) {
      throw new Error(`Oracle HCM fetch failed for "${identifier}": ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const searchItem = (data.items || [])[0];
    const jobs = searchItem?.requisitionList || [];
    if (jobs.length === 0) break;

    allJobs.push(...jobs);
    if (total === null) total = searchItem.TotalJobsCount || 0;
    console.log(`    ...listed ${allJobs.length} / ${total} postings`);

    offset += jobs.length;
    // Paginate on TotalJobsCount, NOT the response's top-level hasMore
    // flag — see file header re: why that flag can't be trusted here.
    if (total && offset >= total) break;
    if (offset > 3000) break; // safety cap, same pattern as the Workday adapter
  }

  const relevantJobs = allJobs.filter((j) => titleLooksRelevant(j.Title));
  console.log(`    ${relevantJobs.length} / ${allJobs.length} titles look relevant — fetching their descriptions...`);

  const detailsPath = "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails";
  const detailed = [];
  for (let i = 0; i < relevantJobs.length; i++) {
    const job = relevantJobs[i];
    try {
      // finder's quotes/punctuation must also stay literal here.
      const finder = `ById;Id="${job.Id}",siteNumber=${siteNumber}`;
      const url = `https://${domain}${detailsPath}?expand=all&onlyData=true&finder=${finder}`;
      const detailRes = await fetchWithTimeout(url, { headers: oracleHeaders() });
      if (!detailRes.ok) continue;
      const detailData = await detailRes.json();
      const detail = (detailData.items || [])[0];
      if (!detail) continue;
      detailed.push({ ...job, detail });
    } catch {
      continue;
    }
    if ((i + 1) % 10 === 0 || i === relevantJobs.length - 1) {
      console.log(`    ...fetched details for ${i + 1} / ${relevantJobs.length}`);
    }
  }

  return detailed;
}

/**
 * Convert one raw Oracle HCM job (list entry + detail merged) into
 * ROOK's canonical job shape.
 */
function normalizeOracleHcmJob(raw, employer) {
  const { domain, siteNumber } = parseOracleIdentifier(employer.ats_identifier);
  const jobUrl = `https://${domain}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${raw.Id}`;
  const detail = raw.detail || {};

  const descriptionHtml = [
    detail.ExternalDescriptionStr,
    detail.ExternalQualificationsStr,
    detail.ExternalResponsibilitiesStr,
  ].filter(Boolean).join(" ");

  const location = raw.PrimaryLocation || (raw.secondaryLocations || []).map((l) => l.Name).join(", ") || "";

  return {
    source_job_id: String(raw.Id),
    employer_id: employer.id,
    source_type: "oraclehcm",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.Title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.ShortDescriptionStr || raw.Title || ""),
    location_raw: location,
    date_posted: raw.PostedDate ? String(raw.PostedDate).slice(0, 10) : null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { fetchOracleHcmJobs, normalizeOracleHcmJob, parseOracleIdentifier };
