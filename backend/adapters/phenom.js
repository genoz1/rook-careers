// Phenom (Phenom People) career-site scraper
//
// Phenom's officially documented Developer API (api.phenom.com/jobs-api)
// requires an OAuth 2.0 token issued per-client by Phenom themselves —
// not something this project can obtain for arbitrary third-party
// employers. However, every Phenom-hosted public career site (the actual
// page a candidate browses) is itself powered by a separate, genuinely
// unauthenticated endpoint: POST https://{domain}/widgets. That's what
// this adapter calls — the same request the career site's own search box
// makes, not the credentialed developer API.
//
// The request payload and response shape below (including the
// data.refineSearch.data.jobs path and the ddoKey field) were confirmed
// against a working third-party example calling a different real
// Phenom-hosted employer (GE Aerospace's careers.geaerospace.com), not
// just documentation — meaningfully more confidence than a pure
// reverse-engineering write-up, though still not tested against a live
// response from this sandbox (no network access to arbitrary external
// domains here).
//
// Known real limitation carried over from that same source: the widgets
// endpoint only returns a short descriptionTeaser, not the full job
// description — getting the complete description requires a second,
// per-job fetch of that job's own detail page, which this adapter does
// not yet do (it uses the teaser as the description). Worth adding if
// full descriptions turn out to matter for matching quality once this
// is live.
//
// This is still meaningfully more fragile than Greenhouse/Lever/Ashby,
// for two reasons:
//   1. Each Phenom site has its own "refNum" code that has to be scraped
//      out of the search-results page's HTML first — there's no way to
//      guess it from the company name, and if Phenom changes how they
//      embed it, this breaks.
//   2. Some company configurations additionally require a CSRF token
//      (fetched via an initial GET before the POST) that this adapter
//      does not yet handle — if a given employer's widgets endpoint
//      starts returning 401/403, this is the likely reason.
//
// You only need the employer's Phenom-hosted careers hostname, e.g.:
//   ats_identifier = "jobs.danaher.com"
// (Danaher hosts every one of its operating companies — Beckman Coulter,
// Cepheid, Leica Biosystems, Leica Microsystems, SCIEX, Pall, Molecular
// Devices, and more — on this one shared Phenom-powered domain, so the
// same identifier covers all of them; only the search keywords differ.)

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

// Scrapes the site's own refNum out of its search-results page HTML —
// every Phenom site embeds this in an inline script tag for its own
// front-end to use when calling /widgets.
async function fetchRefNum(domain) {
  const res = await fetchWithTimeout(`https://${domain}/global/en/search-results`);
  if (!res.ok) throw new Error(`Could not load Phenom search page for "${domain}": ${res.status}`);
  const html = await res.text();
  const match = html.match(/"refNum"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error(`Could not find a refNum on "${domain}" — this site may not actually be on Phenom, or Phenom changed how they embed it`);
  return match[1];
}

async function fetchPhenomJobs(domain) {
  const refNum = await fetchRefNum(domain);
  const size = 20;
  let from = 0;
  const rawJobs = [];
  const maxPages = 50; // safety cap for a very large employer

  for (let page = 0; page < maxPages; page++) {
    const payload = {
      lang: "en_global",
      deviceType: "desktop",
      country: "global",
      pageName: "search-results",
      size,
      from,
      jobs: true,
      counts: true,
      all_fields: ["category", "country", "city", "type"],
      clearAll: false,
      jdsource: "facets",
      isSliderEnable: false,
      pageId: "page20",
      siteType: "external",
      keywords: "",
      global: true,
      selected_fields: {},
      sort: { order: "desc", field: "postedDate" },
      locationData: {},
      refNum,
      ddoKey: "refineSearch",
    };
    let res;
    try {
      res = await fetchWithTimeout(`https://${domain}/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      break;
    }
    if (!res.ok) break;
    const data = await res.json();
    // Confirmed real response shape (found via a working third-party
    // example against a different Phenom-hosted employer): the actual
    // job array lives at data.refineSearch.data.jobs, not data.jobs.data
    // as originally guessed here.
    const pageJobs = data?.refineSearch?.data?.jobs || [];
    if (!Array.isArray(pageJobs) || pageJobs.length === 0) break;

    rawJobs.push(...pageJobs);
    console.log(`    ...listed ${rawJobs.length} posting(s) so far`);
    if (pageJobs.length < size) break; // last page
    from += size;
  }

  const relevant = rawJobs.filter((j) => titleLooksRelevant(j.title || j.job_title || ""));
  console.log(`    ${relevant.length} / ${rawJobs.length} titles look relevant`);
  return relevant;
}

/**
 * Convert one raw Phenom job into ROOK's canonical job shape.
 *
 * NOTE: field names here (title, job_req_id, city/state/country,
 * job_seq_no, apply_url) are a best-effort guess based on third-party
 * documentation of Phenom's widget response shape, not a verified real
 * response — this is the piece most likely to need correcting on the
 * first real run against a live Phenom employer.
 */
function normalizePhenomJob(raw, employer) {
  const jobId = raw.job_req_id || raw.jobId || raw.job_seq_no || raw.id;
  const title = raw.title || raw.job_title || "";
  const location = [raw.city, raw.state, raw.country].filter(Boolean).join(", ") || raw.location || "";
  const jobUrl = raw.apply_url || raw.applyUrl || `https://${employer.ats_identifier}/job/${jobId}`;

  return {
    source_job_id: String(jobId),
    employer_id: employer.id,
    source_type: "phenom",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: title,
    company_name: raw.company || employer.company_name,
    description_html: raw.descriptionTeaser || null,
    description_text: stripHtml(raw.descriptionTeaser || title),
    location_raw: location,
    date_posted: raw.postedDate || raw.posted_date || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchPhenomJobs, normalizePhenomJob };
