// Jobvite career-site scraper
//
// Jobvite's own REST API is per-customer (needs credentials issued to
// that specific employer, which this project has no way to obtain), and
// their optional public syndication feed is off by default for most
// customers — there is no reliable general-purpose public API here,
// unlike Greenhouse/Lever/Ashby. What IS reliably public: every Jobvite
// employer's own career site at jobs.jobvite.com/{company}, and
// specifically its /jobs/viewall page, which is server-rendered with a
// full, un-paginated list of every open role grouped by department —
// so this adapter scrapes that page directly, same approach as the
// existing TalentBrew adapter.
//
// Same fragility caveat as TalentBrew/ClinchTalent: if Jobvite changes
// this page's markup, the regex below can break silently. It was built
// against Jobvite's markdown-rendered page content, not raw HTML source
// (no network access to arbitrary external domains from this sandbox),
// so treat the first real ingestion run against each new Jobvite
// employer as the actual test — location parsing especially, which is
// the most template-dependent part of this page and the piece most
// likely to need adjustment.
//
// You only need the employer's Jobvite company slug, e.g.:
//   ats_identifier = "neogenomics"
// (from https://jobs.jobvite.com/neogenomics)

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "territory manager", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant", "director"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical", "oncology",
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

async function fetchJobviteJobs(companySlug) {
  const url = `https://jobs.jobvite.com/${companySlug}/jobs/viewall`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Jobvite fetch failed for "${companySlug}": ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Jobvite job links follow: https://jobs.jobvite.com/{company}/job/{jobId}
  const linkPattern = new RegExp(
    `<a[^>]+href="https://jobs\\.jobvite\\.com/${companySlug}/job/([^"]+)"[^>]*>([^<]+)</a>`,
    "g"
  );
  const rawJobs = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const [, jobId, titleRaw] = match;
    rawJobs.push({ jobId, title: titleRaw.trim() });
  }
  console.log(`    ...listed ${rawJobs.length} posting(s)`);

  // De-dupe (a job can legitimately appear once under "Featured Jobs"
  // and again under its department section further down the page).
  const seen = new Set();
  const deduped = rawJobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });

  const relevant = deduped.filter((j) => titleLooksRelevant(j.title));
  console.log(`    ${relevant.length} / ${deduped.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevant.length; i++) {
    const job = relevant[i];
    try {
      const detailRes = await fetchWithTimeout(`https://jobs.jobvite.com/${companySlug}/job/${job.jobId}`);
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
 * Convert one raw scraped Jobvite job into ROOK's canonical job shape.
 *
 * NOTE: the description-extraction regex below is a best-effort guess,
 * not verified against real raw HTML source (see file header) — the
 * piece most likely to need adjustment on the first real run.
 */
function normalizeJobviteJob(raw, employer) {
  const jobUrl = `https://jobs.jobvite.com/${employer.ats_identifier}/job/${raw.jobId}`;

  const descMatch = raw.detailHtml.match(
    /<div[^>]*class="[^"]*(?:jv-job-detail-description|job-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const descriptionHtml = descMatch ? descMatch[1] : "";

  // Best-effort location extraction — Jobvite detail pages typically
  // show "City, State" near the top; not reliably parseable from a
  // regex against markdown-rendered content alone (see file header),
  // so this deliberately falls back to empty rather than guessing wrong.
  const locMatch = raw.detailHtml.match(/<span[^>]*class="[^"]*jv-job-detail-location[^"]*"[^>]*>([^<]+)<\/span>/i);
  const locationRaw = locMatch ? locMatch[1].trim() : "";

  return {
    source_job_id: raw.jobId,
    employer_id: employer.id,
    source_type: "jobvite",
    source_url: jobUrl,
    application_url: jobUrl,
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

module.exports = { fetchJobviteJobs, normalizeJobviteJob };
