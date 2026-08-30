// "Drupal careers" site scraper
//
// A distinct pattern from the other custom-site adapters here: this one
// is fully server-rendered plain HTML (confirmed directly against a real
// live page — Hologic's careers.hologic.com/en/search), no JavaScript
// execution needed at all, with simple numbered-page pagination and
// clean job detail links. Genuinely more reliable to scrape than
// Phenom/Jobvite/iCIMS/ApplicantPro precisely because there's no dynamic
// client-side rendering or session/token handling involved — what you
// fetch is what a browser would see.
//
// Still a scraper rather than an API, so the usual caveat applies: if
// the employer changes their page markup, this can break silently.
// Confirmed for Hologic specifically; other employers on what looks
// like the same underlying platform (a Drupal-based enterprise careers
// CMS) have not been individually verified — treat each new employer's
// first real ingestion run as the actual test for that employer.
//
// You only need the employer's careers domain, e.g.:
//   ats_identifier = "careers.hologic.com"
// (from https://careers.hologic.com/en/search)

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

async function fetchDrupalCareersJobs(domain) {
  const rawJobs = [];
  const seen = new Set();
  const maxPages = 25; // safety cap for a very large employer

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://${domain}/en/search?page=${page}`;
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch {
      break;
    }
    if (!res.ok) break;
    const html = await res.text();

    // Matches: <a href="/search/{id}/{slug}">Title</a> — the job detail
    // links this platform renders directly in the results list.
    const linkPattern = /<a[^>]*href="(\/search\/(\d+)\/[a-z0-9-]+)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    let foundOnThisPage = 0;
    while ((match = linkPattern.exec(html)) !== null) {
      const [, path, jobId, title] = match;
      if (seen.has(jobId)) continue;
      seen.add(jobId);
      rawJobs.push({ jobId, title: title.trim(), url: `https://${domain}${path}` });
      foundOnThisPage++;
    }
    if (foundOnThisPage === 0) break; // last page reached
  }
  console.log(`    ...listed ${rawJobs.length} posting(s)`);

  const relevant = rawJobs.filter((j) => titleLooksRelevant(j.title));
  console.log(`    ${relevant.length} / ${rawJobs.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevant.length; i++) {
    const job = relevant[i];
    try {
      const detailRes = await fetchWithTimeout(job.url);
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
 * NOTE: description/location extraction is a best-effort guess at this
 * platform's typical detail-page structure — the piece most likely to
 * need adjustment per employer, since exact class names can vary between
 * different companies' theming of the same underlying platform.
 */
function normalizeDrupalCareersJob(raw, employer) {
  const descMatch = raw.detailHtml.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const descriptionHtml = descMatch ? descMatch[1] : "";

  const locMatch = raw.detailHtml.match(/<span[^>]*class="[^"]*job-location[^"]*"[^>]*>([^<]+)<\/span>/i);
  const locationRaw = locMatch ? locMatch[1].trim() : "";

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "drupalcareers",
    source_url: raw.url,
    application_url: raw.url,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: locationRaw,
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchDrupalCareersJobs, normalizeDrupalCareersJob };
