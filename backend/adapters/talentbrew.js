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

const RELEVANT_TITLE_KEYWORDS = [
  "sales", "account executive", "territory", "representative", "specialist",
  "business development", "key account", "regional manager", "clinical",
];

function titleLooksRelevant(title = "") {
  const t = title.toLowerCase();
  return RELEVANT_TITLE_KEYWORDS.some((k) => t.includes(k));
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
async function fetchTalentBrewJobs(hostname) {
  const base = `https://${hostname}`;
  const rawJobs = [];
  const maxPages = 40; // safety cap — see file header re: scale

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${base}/search-jobs` : `${base}/search-jobs&p=${page}`;
    let res;
    try {
      res = await fetch(url);
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
  const detailed = [];
  for (const job of deduped) {
    if (!titleLooksRelevant(job.title)) continue;
    try {
      const detailRes = await fetch(`${base}${job.path}`);
      if (!detailRes.ok) continue;
      const detailHtml = await detailRes.text();
      detailed.push({ ...job, detailHtml });
    } catch {
      continue;
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
