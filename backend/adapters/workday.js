// Workday CXS (Career Site) API adapter
//
// Public, unauthenticated endpoint — no signup, no API key required. This
// is the same API that powers the search box on a company's own public
// Workday careers site, so it's meant to be called from outside code.
//
// NOTE: unlike the Greenhouse/Lever/Ashby adapters, this one has not been
// tested against a live Workday endpoint — the sandbox this was written in
// can't reach myworkdayjobs.com. It's built to Workday's well-documented
// public API shape, but treat the first real ingestion run against each
// new Workday employer as the real test.
//
// You need three pieces of information per employer, all visible in their
// careers site URL:
//   https://{tenant}.{wdNumber}.myworkdayjobs.com/{site}
//   e.g. https://idexx.wd1.myworkdayjobs.com/IDEXX
//        tenant = "idexx", wdNumber = "wd1", site = "IDEXX"
//
// Store all three in the employers.ats_identifier column as a single
// pipe-delimited string: "tenant|wdNumber|site"
//   e.g. "idexx|wd1|IDEXX"

function parseWorkdayIdentifier(identifier) {
  const parts = (identifier || "").split("|");
  const [tenant, wdNumber, site] = parts;
  if (!tenant || !wdNumber || !site) {
    throw new Error(
      `Malformed Workday ats_identifier "${identifier}" — expected "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"`
    );
  }
  return { tenant, wdNumber, site };
}

/**
 * Fetch all currently published jobs for one employer's Workday site,
 * including full descriptions. Workday paginates in batches (20 by
 * default); this walks every page, then fetches each job's detail page
 * separately since the list endpoint doesn't include full descriptions.
 *
 * @param {string} identifier - "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"
 */

// Same relevance filter used in ingest.js — applied here as a pre-filter
// before fetching each job's full detail page, since detail fetches are
// the slow part (one request per job, done sequentially). For a large
// employer (Labcorp, IDEXX, etc. can have hundreds of postings), fetching
// full descriptions for obviously-irrelevant jobs (warehouse, lab tech,
// packaging) wastes most of the run's time on titles that will just get
// filtered out afterward anyway.
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

// Wraps fetch() with a timeout so one stalled request can't hang the
// entire ingestion run forever — without this, a single unresponsive
// endpoint blocks every job after it indefinitely.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkdayJobs(identifier) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;

  const allPostings = [];
  const pageSize = 20;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const res = await fetchWithTimeout(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: pageSize, offset, searchText: "" }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(
        `Workday fetch failed for "${identifier}": ${res.status} ${res.statusText}` +
          (bodyText ? ` — ${bodyText.slice(0, 300)}` : "")
      );
    }
    const data = await res.json();
    // Only trust a new total if it's a real positive number — some
    // Workday tenants omit or zero out `total` on paginated (non-first)
    // requests, which was silently truncating results to just the first
    // couple pages for several employers (Covetrus, Elanco, Cardinal
    // Health, MWI all stopped at 40 jobs regardless of their real count).
    if (typeof data.total === "number" && data.total > 0) {
      total = data.total;
    }
    allPostings.push(...(data.jobPostings || []));
    offset += pageSize;
    console.log(`    ...listed ${allPostings.length} / ${total} postings`);

    // Safety cap so a very large employer (or an unexpected API response)
    // can't loop forever.
    if (offset > 2000) break;
  }

  // Only fetch full detail for postings that already look relevant by
  // title — see titleLooksRelevant() above for why. This is the slow part
  // (one request per job, sequential), so it logs progress every 10 jobs.
  const relevantPostings = allPostings.filter((p) => titleLooksRelevant(p.title));
  console.log(`    ${relevantPostings.length} / ${allPostings.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevantPostings.length; i++) {
    const posting = relevantPostings[i];
    try {
      const detailRes = await fetchWithTimeout(`${baseUrl}${posting.externalPath}`);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      detailed.push({ ...posting, detail });
    } catch {
      // Skip jobs whose detail fetch fails (including timeouts) rather
      // than aborting the whole run.
      continue;
    }
    if ((i + 1) % 10 === 0 || i === relevantPostings.length - 1) {
      console.log(`    ...fetched details for ${i + 1} / ${relevantPostings.length}`);
    }
  }

  return detailed;
}

/**
 * Convert one raw Workday job (list entry + detail merged) into ROOK's
 * canonical job shape.
 */
function normalizeWorkdayJob(raw, employer) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(employer.ats_identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/${site}`;
  const jobUrl = `${baseUrl}${raw.externalPath}`;
  const info = raw.detail?.jobPostingInfo || {};

  return {
    source_job_id: info.jobReqId || raw.bulletFields?.[0] || raw.externalPath,
    employer_id: employer.id,
    source_type: "workday",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: info.jobDescription || null,
    description_text: stripHtml(info.jobDescription || ""),
    location_raw: raw.locationsText || "",
    // Workday's list view only gives relative text ("Posted 3 Days Ago"),
    // not a real date — leaving this null rather than guessing.
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = { fetchWorkdayJobs, normalizeWorkdayJob, parseWorkdayIdentifier };
