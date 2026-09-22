// SAP SuccessFactors Career Site Builder (CSB) adapter
//
// REPLACED Sept 2026 — the previous version of this file guessed at a
// public "/api/rest/2.0/posting" JSON endpoint. That endpoint does not
// exist for CSB tenants: SuccessFactors' real public-facing OData API
// (/odata/v2/JobRequisition) is tenant-gated behind OAuth credentials
// ROOK doesn't have and can't get without each employer's cooperation —
// confirmed via SAP's own documented behavior, not assumed. This is why
// every SuccessFactors employer in production was failing identically
// (Astellas, Boehringer Ingelheim, Daiichi Sankyo, Novo Nordisk all
// sync_status=error) regardless of tenant: the guessed endpoint was
// simply wrong for all of them, not four unrelated bugs.
//
// WHAT ACTUALLY WORKS: CSB's own public search-results page, the same
// HTML a visitor's browser loads. Checked directly against 10 real CSB
// tenants (Astellas, Getinge, Boston Scientific, Olympus, Teleflex,
// Terumo, Dentsply Sirona, KARL STORZ, DiaSorin, Boehringer Ingelheim) —
// all ten returned real, specific job titles and detail links in the
// page's own markup, no JavaScript execution needed to see them. Two
// more (Kedrion, Ambu) returned nothing at all on the same request
// shape; that's consistent with either a genuinely JS-rendered results
// grid OR a cookie-consent interstitial swallowing the real content
// server-side for EU-based sites — those two tenants could not be
// distinguished from research alone and are NOT wired up below; treat
// them as NEEDS_ADAPTER until someone inspects the real response.
//
// URL SHAPE (consistent across every CSB tenant checked):
//   results page:  https://{host}/search/?q={query}&startrow={n}
//   detail page:   https://{host}/job/{City-Job-Title-ST-ZIP}/{numericId}/
// The detail URL's own slug reliably encodes city + 2-letter state code
// + 5-digit ZIP right before the numeric ID — used below as a fallback
// location source when the results row itself doesn't carry a separate
// location cell, since that slug format was consistent across every
// tenant inspected.
//
// IDENTIFIER FORMAT: identical to before — the base hostname of the
// company's careers site, e.g. "careers.astellas.com".
//
// NOT VERIFIED AGAINST LIVE RAW HTML: this environment has no outbound
// network access to arbitrary external hosts (see repo README / any
// other adapter's header for the same caveat), so the exact row/cell
// markup below is inferred from a research tool's structural
// descriptions of these pages, not confirmed byte-for-byte. The
// selectors are written defensively (several fallback strategies per
// field, see extractRows/extractLocation) for exactly that reason.
// Treat the first real ingestion run against each tenant as the actual
// test, same convention as every other "not verified live" adapter in
// this codebase (icims.js, ukg.js, workday.js when first written).

const cheerio = require("cheerio");
const { titleLooksRelevant } = require("../relevanceFilter");
const { resolveUsStateCode } = require("../jobEligibility");

const MAX_PAGES = 1000; // Defensive ceiling: unfinished pagination must fail, never truncate.
const MAX_DETAIL_FETCHES = 60; // only relevant (sales-filtered) rows get a detail-page fetch for full description

function clean(value) {
  return String(value || "").replace(/[​ ]/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Pull city/state/zip out of a CSB detail URL's own slug — the one part
// of this adapter checked against several *different* real tenants'
// actual URLs (see file header), not just described secondhand:
//   .../job/Boston-Territory-Manager%2C-Surgical-Workplace-MA-02108/1424825633/
//   .../job/AUSTIN-Molecular-Account-Executive-Upstate-New-York-TX-78727/1372240657/
function locationFromDetailUrl(detailUrl) {
  try {
    const path = decodeURIComponent(new URL(detailUrl).pathname);
    const slugMatch = path.match(/\/job\/([^/]+)\/\d+\/?$/);
    if (!slugMatch) return null;
    const slug = slugMatch[1];
    const tail = slug.match(/^(.*?)-([A-Za-z]{2})-(\d{5})$/);
    if (!tail) {
      // Some tenants put "City, ST" at the start of the URL and omit a
      // trailing ZIP (for example Boehringer's "Stockton, CA-ILD-...").
      const leading = slug.match(/^([^,-]{2,50}),\s*-?([A-Za-z]{2})-/);
      const state = leading && resolveUsStateCode(leading[2]);
      return state ? `${clean(leading[1])}, ${state}` : null;
    }
    const stateCode = resolveUsStateCode(tail[2]);
    if (!stateCode) return null;
    const cityGuess = clean(tail[1].split("-")[0]);
    return cityGuess ? `${cityGuess}, ${stateCode}` : stateCode;
  } catch {
    return null;
  }
}

// A results row's own visible text sometimes carries the real location
// (whatever cell layout the tenant's CSB skin uses) — tried first since
// it's more precise than the URL-slug fallback when present.
function locationFromRowText(rowText, title) {
  const withoutTitle = clean(rowText.replace(title, ""));
  // Matches "City, ST" or "City, State" anywhere in the row's remaining
  // text, which is what's left once the title itself is stripped out.
  const match = withoutTitle.match(/\b([A-Za-z .'-]{2,40}),\s*([A-Za-z]{2})\b/);
  if (match) {
    const stateCode = resolveUsStateCode(match[2]);
    if (stateCode) return `${clean(match[1])}, ${stateCode}`;
  }
  return null;
}

// Extracts every job row from one results page: a link to a /job/...
// detail page, whose visible text is the title. Works whether the
// tenant's skin uses a literal <table> (Astellas) or a div-based grid —
// this only depends on the /job/ URL pattern and doesn't assume a
// specific wrapping tag, deliberately, since that varies by tenant skin
// even within the same CSB template family.
function extractRows($, host) {
  const rows = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || !/\/job\/[^/]+\/\d+\/?/.test(href)) return;
    let detailUrl;
    try {
      detailUrl = new URL(href, `https://${host}`).href;
    } catch {
      return;
    }
    if (seen.has(detailUrl)) return;
    const title = clean($(a).text());
    if (!title || title.length < 4 || title.length > 160) return;
    seen.add(detailUrl);

    // Look at the row's own text (nearest <tr>, else immediate parent) for
    // a location the results grid may already display next to the title.
    const row = $(a).closest("tr");
    const rowText = clean((row.length ? row.text() : $(a).parent().text()) || "");
    const location = locationFromRowText(rowText, title) || locationFromDetailUrl(detailUrl);

    rows.push({ title, detailUrl, location });
  });
  return rows;
}

// Finds the next results-page URL if the page provides one — several
// href shapes are tried rather than one hardcoded pagination parameter,
// since CSB doesn't standardize that across every tenant skin.
function findNextPageUrl($, currentUrl) {
  const current = new URL(currentUrl);
  const forwards = [];
  for (const el of $('a[rel="next"], a.next, .pagination a, a[href*="startrow"], a[href*="p="]').toArray()) {
    if ($(el).attr('aria-disabled') === 'true' || $(el).hasClass('disabled')) continue;
    // » is the CSB "Last Page" jump, not the next page. Treating it as
    // next skipped every middle page and then looped on the last page.
    const explicit = $(el).attr('rel') === 'next' || $(el).hasClass('next') || /^(next|>)$/i.test(clean($(el).text()));
    const href = $(el).attr('href');
    if (!href) { if (explicit) throw new Error('SuccessFactors incomplete pagination: missing next href'); continue; }
    let next;
    try { next = new URL(href, current); } catch { throw new Error('SuccessFactors incomplete pagination: invalid next URL'); }
    if (next.origin !== current.origin || next.pathname !== current.pathname) {
      if (explicit) throw new Error('SuccessFactors incomplete pagination: unexpected next URL');
      continue;
    }
    if (explicit) return next.href;
    for (const key of ['startrow', 'p']) {
      if (!next.searchParams.has(key)) continue;
      const n = Number(next.searchParams.get(key));
      const previous = Number(current.searchParams.get(key) || (key === 'p' ? 1 : 0));
      if (Number.isFinite(n) && n > previous) forwards.push({ url: next.href, n });
    }
  }
  forwards.sort((a, b) => a.n - b.n);
  return forwards[0]?.url || null;
}

async function fetchDetailDescription(detailUrl) {
  try {
    const res = await fetchWithTimeout(detailUrl);
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer").remove();
    // CSB detail pages generally render the description in a main content
    // area; fall back to the whole body text if no obviously-scoped
    // container is found, rather than returning nothing.
    const main = $("main, .jobdescription, #jobdescription, article").first();
    return clean((main.length ? main : $("body")).text());
  } catch {
    return "";
  }
}

/**
 * Fetch all relevant jobs from a SuccessFactors Career Site Builder site.
 * @param {string} identifier - hostname, e.g. "careers.astellas.com"
 * @returns {Promise<Array>} raw row objects (title, detailUrl, location, description)
 */
async function fetchSuccessFactorsJobs(identifier, { maxPages = MAX_PAGES } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("Invalid SuccessFactors page limit");
  const host = identifier.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let url = `https://${host}/search/?q=sales`;
  const allRows = [];
  const seenUrls = new Set();

  const visited = new Set();
  for (let page = 0; url; page++) {
    if (page >= maxPages) throw new Error("SuccessFactors incomplete extraction: pagination safety limit reached");
    const canonical = new URL(url); canonical.searchParams.sort();
    if (visited.has(canonical.href)) throw new Error("SuccessFactors incomplete extraction: pagination cycle");
    visited.add(canonical.href);
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`SuccessFactors fetch failed for "${host}": ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const $ = cheerio.load(html);
    const rows = extractRows($, host).filter((r) => !seenUrls.has(r.detailUrl));
    const nextUrl = findNextPageUrl($, url);
    if (rows.length === 0) {
      // Nothing at all on the first page. This is NOT automatically a
      // legitimate "zero jobs" result — treating it as one would let
      // ingest.js close every existing job for this employer just
      // because a cookie-consent wall or a JS-only results grid
      // swallowed the real content (exactly the Kedrion/Ambu shape
      // noted in this file's header). Only accept it as empty when the
      // page itself explicitly says so in visible text; otherwise this
      // is indistinguishable from a blocked/broken fetch and must fail
      // loudly so the caller's existing-jobs-stay-open safeguard holds.
      const pageText = clean($("body").text()).toLowerCase();
      const explicitlyEmpty = /no (?:current |open |available )?(?:positions|jobs|openings|vacancies|results) (?:found|available|matching)?|0 results/i.test(
        pageText
      );
      if (explicitlyEmpty && page === 0 && !nextUrl) break;
      throw new Error(
        `SuccessFactors "${host}" returned no job rows and no explicit empty-results text — likely blocked, JS-rendered, or a cookie-consent wall, not a genuine zero-job result`
      );
    }
    for (const r of rows) seenUrls.add(r.detailUrl);
    allRows.push(...rows);
    url = nextUrl;
  }

  const relevant = allRows.filter((r) => titleLooksRelevant(r.title));

  const withDescriptions = [];
  for (let i = 0; i < relevant.length; i++) {
    const row = relevant[i];
    const description = i < MAX_DETAIL_FETCHES ? await fetchDetailDescription(row.detailUrl) : "";
    withDescriptions.push({ ...row, description });
  }
  return withDescriptions;
}

function normalizeSuccessFactorsJob(raw, employer, host) {
  const idMatch = raw.detailUrl.match(/\/job\/[^/]+\/(\d+)\/?/);
  const jobId = idMatch ? idMatch[1] : raw.detailUrl;

  return {
    source_job_id: jobId,
    employer_id: employer.id,
    source_type: "successfactors",
    source_url: raw.detailUrl,
    application_url: raw.detailUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: "",
    description_text: raw.description || "",
    location_raw: raw.location || "",
    date_posted: null,
    status: "active",
    // The detail page itself is fetched and read (not guessed), so this
    // is a real first-party posting even where location parsing missed —
    // an empty location_raw doesn't mean the job itself is unverified.
    source_verified: true,
  };
}

module.exports = {
  fetchSuccessFactorsJobs,
  normalizeSuccessFactorsJob,
  // exported for testing
  extractRows,
  locationFromDetailUrl,
  locationFromRowText,
  findNextPageUrl,
};
