// iCIMS career-site scraper
//
// iCIMS has no public JSON job API at all — the real Customer/Partner
// API is OAuth-gated and issued only to iCIMS's own customers. What IS
// publicly reachable: the employer's own career-site search page at
// {company}.icims.com/jobs/search, which iCIMS itself renders as plain
// HTML (no JSON-LD, unlike some other ATSs) inside an iframe. Adding
// ?in_iframe=1 returns just that inner content without the page chrome
// around it, which is what this scrapes directly.
//
// More fragile than Greenhouse/Lever/Ashby for a few reasons: this is
// pure HTML scraping, not a documented API; iCIMS's own CSS class names
// (the "iCIMS_" prefix) are known to vary somewhat between tenant
// versions; and some iCIMS deployments sit behind Cloudflare protection
// that can block plain server-to-server requests entirely. Built from a
// third-party scraping guide's example code, not verified against a
// real live response (no network access to arbitrary external domains
// from this sandbox) — treat the first real ingestion run against a
// live iCIMS employer as the actual test, and expect this adapter
// specifically to need adjustment sooner than the API-based ones if a
// given tenant's markup doesn't match what's assumed below.
//
// You only need the employer's iCIMS subdomain, e.g.:
//   ats_identifier = "careers-bruker"
// (from https://careers-bruker.icims.com, sometimes written as
// worldwidecareers-{company} or careers-{company} depending on the
// tenant — check the employer's actual careers link for the exact
// subdomain rather than assuming the pattern.)

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant", "director"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical", "scientific",
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
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // A standard desktop user-agent avoids some tenants redirecting
        // to a differently-structured mobile version.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIcimsJobs(subdomain) {
  const baseUrl = `https://${subdomain}.icims.com`;
  const res = await fetchWithTimeout(`${baseUrl}/jobs/search?in_iframe=1`);
  if (!res.ok) throw new Error(`iCIMS fetch failed for "${subdomain}": ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Matches iCIMS's own anchor markup: <a class="iCIMS_Anchor ..."
  // href="/jobs/1234/job-title/login?...">Job Title</a>. Title comes
  // from the title="" attribute when present (more reliable than the
  // link text, which can include extra whitespace/icons), falling back
  // to the visible text.
  const linkPattern = /<a[^>]*class="[^"]*iCIMS_Anchor[^"]*"[^>]*href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*(?:title="([^"]*)")?[^>]*>([^<]*)<\/a>/g;
  const rawJobs = [];
  const seen = new Set();
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const [, href, jobId, titleAttr, linkText] = match;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    const title = (titleAttr || linkText || "").trim();
    if (!title) continue;
    const fullUrl = href.startsWith("http") ? href : `${baseUrl}${href}`;
    rawJobs.push({ jobId, title, url: fullUrl });
  }
  console.log(`    ...listed ${rawJobs.length} posting(s)`);

  const relevant = rawJobs.filter((j) => titleLooksRelevant(j.title));
  console.log(`    ${relevant.length} / ${rawJobs.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevant.length; i++) {
    const job = relevant[i];
    try {
      const detailRes = await fetchWithTimeout(`${job.url}${job.url.includes("?") ? "&" : "?"}in_iframe=1`);
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
 * Convert one raw scraped iCIMS job into ROOK's canonical job shape.
 *
 * NOTE: the description and location extraction below are best-effort
 * guesses at iCIMS's typical detail-page structure, not verified
 * against real raw HTML (see file header) — the piece most likely to
 * need adjustment on the first real run.
 */
function normalizeIcimsJob(raw, employer) {
  const descMatch = raw.detailHtml.match(
    /<div[^>]*class="[^"]*iCIMS_JobContent[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
  );
  const descriptionHtml = descMatch ? descMatch[1] : "";

  const locMatch = raw.detailHtml.match(/<span[^>]*class="[^"]*iCIMS_JobHeaderLocation[^"]*"[^>]*>([^<]+)<\/span>/i);
  const locationRaw = locMatch ? locMatch[1].trim() : "";

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "icims",
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

module.exports = { fetchIcimsJobs, normalizeIcimsJob };
