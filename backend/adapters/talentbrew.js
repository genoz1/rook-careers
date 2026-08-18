// TalentBrew (Radancy) career-site scraper
//
// Unlike Greenhouse/Lever/Ashby/Workday, TalentBrew does not expose a
// documented public JSON API — it's a server-rendered search page, so this
// adapter parses the HTML directly instead of calling a clean API. That
// makes it meaningfully more fragile than the other adapters: if an
// employer's TalentBrew theme changes, the regex patterns below can break
// silently. Treat the first real ingestion run against each new TalentBrew
// employer as a real test, and expect this one specifically to need
// occasional maintenance in a way Workday/Greenhouse/Lever/Ashby shouldn't.
//
// You only need the employer's careers-site hostname, e.g.:
//   ats_identifier = "careers.questdiagnostics.com"
//
// TalentBrew search pages can list thousands of jobs for a large employer
// (Quest alone has 2000+). To keep ingestion reasonably fast and avoid
// hammering the site, this adapter does a lightweight keyword check on the
// TITLE before fetching each job's full detail page — full descriptions
// are only fetched for postings that already look relevant, not for every
// single listing.

// Same relevance filter used in ingest.js — kept in sync with it. See the
// comment there for why this is a two-tier check rather than a flat
// keyword list.
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
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Fetch jobs from a TalentBrew-powered careers site by scraping the
 * search-results HTML directly.
 *
 * @param {string} hostname - e.g. "careers.questdiagnostics.com"
 */

// Wraps fetch() with a timeout so one stalled request can't hang the
// entire ingestion run forever.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTalentBrewJobs(hostname) {
  const base = `https://${hostname}`;
  const rawJobs = [];
  const maxPages = 40; // safety cap — see file header re: scale

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${base}/search-jobs` : `${base}/search-jobs&p=${page}`;
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch {
      break;
    }
    if (!res.ok) break;
    const html = await res.text();

    // TalentBrew job links follow: /job/{location-slug}/{title-slug}/{orgId}/{jobId}
    const linkPattern = /<a[^>]+href="(\/job\/[^"]+\/(\d+)\/(\d+))"[^>]*>([^<]+)</g;
    let match;
    let foundOnPage = 0;
    while ((match = linkPattern.exec(html)) !== null) {
      const [, path, , jobId, titleRaw] = match;
      foundOnPage++;
      rawJobs.push({ path, jobId, title: titleRaw.trim() });
    }
    console.log(`    ...page ${page}: ${foundOnPage} listing(s) found (${rawJobs.length} total so far)`);

    if (foundOnPage === 0) break; // no more results — stop paginating
  }

  // De-dupe (the same job link can appear more than once on a page for
  // accessibility markup / "featured jobs" sections).
  const seen = new Set();
  const deduped = rawJobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });

  // Fetch full detail only for postings that already look relevant by title.
  const relevant = deduped.filter((j) => titleLooksRelevant(j.title));
  console.log(`    ${relevant.length} / ${deduped.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevant.length; i++) {
    const job = relevant[i];
    try {
      const detailRes = await fetchWithTimeout(`${base}${job.path}`);
      if (!detailRes.ok) continue;
      const detailHtml = await detailRes.text();
      detailed.push({ ...job, detailHtml });
    } catch {
      continue;
    }
    if ((i + 1) % 10 === 0 || i === relevant.length - 1) {
      console.log(`    ...fetched details for ${i + 1} / ${relevant.length}`);
    }
  }

  return detailed;
}

/**
 * Convert one raw scraped job into ROOK's canonical job shape.
 *
 * NOTE: the description-extraction regex below is a best-effort guess at
 * TalentBrew's typical markup — it has not been verified against real raw
 * HTML source (only against a text-rendered version of one page). This is
 * the piece most likely to need adjustment on the first real run.
 */
function normalizeTalentBrewJob(raw, employer) {
  const base = `https://${employer.ats_identifier}`;
  const jobUrl = `${base}${raw.path}`;

  const descMatch = raw.detailHtml.match(
    /<div[^>]*class="[^"]*(?:job-description|jobDescription)[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const descriptionHtml = descMatch ? descMatch[1] : "";

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "talentbrew",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: "", // not reliably parseable from the list page alone — see file notes
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchTalentBrewJobs, normalizeTalentBrewJob };
