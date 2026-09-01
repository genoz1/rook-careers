// Teamtailor career-site scraper
//
// Teamtailor's real API (api.teamtailor.com/v1) is per-tenant — each
// customer mints their own API key inside their own admin panel, and a
// key from one tenant can't read another's data, so there's no way to
// use it across many different employers. What IS usable: every
// Teamtailor customer's public career site is statically server-rendered
// (confirmed directly — 3Shape's careers.3shape.com/jobs page returns
// full job listings as plain HTML, no JavaScript execution needed),
// unlike several of the other adapters built this session.
//
// Many companies run this on their own custom domain (e.g.
// careers.3shape.com) rather than a *.teamtailor.com subdomain, so the
// identifier here is the employer's actual careers domain, not a
// guessable Teamtailor-specific slug.
//
// You only need the employer's careers domain, e.g.:
//   ats_identifier = "careers.3shape.com"

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant", "director"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical", "dental",
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
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTeamtailorJobs(domain) {
  const url = `https://${domain}/jobs`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Teamtailor fetch failed for "${domain}": ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Teamtailor job links: /jobs/{numericid}-{slug}
  const linkPattern = new RegExp(`<a[^>]+href="(?:https://${domain})?(/jobs/(\\d+)-[a-z0-9-]+)"[^>]*>([^<]+)</a>`, "gi");
  const rawJobs = [];
  const seen = new Set();
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const [, path, jobId, title] = match;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    rawJobs.push({ jobId, title: title.trim(), url: `https://${domain}${path}` });
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
 * Convert one raw scraped Teamtailor job into ROOK's canonical job shape.
 *
 * NOTE: description/location extraction is a best-effort guess at
 * Teamtailor's typical detail-page structure, not verified against raw
 * HTML source for a variety of tenants — the piece most likely to need
 * adjustment per employer, since different companies theme their career
 * pages differently even on the same underlying platform.
 */
function normalizeTeamtailorJob(raw, employer) {
  const descMatch = raw.detailHtml.match(/<div[^>]*class="[^"]*body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const descriptionHtml = descMatch ? descMatch[1] : "";

  const locMatch = raw.detailHtml.match(/<span[^>]*class="[^"]*job-location[^"]*"[^>]*>([^<]+)<\/span>/i);
  const locationRaw = locMatch ? locMatch[1].trim() : "";

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "teamtailor",
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

module.exports = { fetchTeamtailorJobs, normalizeTeamtailorJob };
