// ClinchTalent career-site scraper
//
// Like TalentBrew, ClinchTalent (used by Foundation Medicine and other
// employers) doesn't expose a documented public JSON API — it's a
// server-rendered search page, so this adapter parses the HTML directly.
// Same fragility caveat as the TalentBrew adapter: if an employer's
// ClinchTalent theme changes, these patterns can break silently.
//
// NOTE: the description-extraction regex below is a best-effort guess at
// ClinchTalent's typical markup — it was written against a text-rendered
// version of Foundation Medicine's careers page, not verified against raw
// HTML source. This is the piece most likely to need adjustment on the
// first real run, same situation the TalentBrew adapter was in initially.
//
// You only need the employer's careers-site hostname, e.g.:
//   ats_identifier = "careers.foundationmedicine.com"
//
// Job listing pages follow /jobs/search?page={n}; individual job pages
// follow /jobs/{slug} with no separate numeric ID in most cases observed
// — the slug itself is used as source_job_id since it's unique per
// title+location combination.

const { titleLooksRelevant } = require('../relevanceFilter');

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

async function fetchClinchTalentJobs(hostname) {
  const base = `https://${hostname}`;
  const rawJobs = [];
  const maxPages = 20; // safety cap — a 500-posting employer over ~30/page

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${base}/jobs/search` : `${base}/jobs/search?page=${page}`;
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch {
      break;
    }
    if (!res.ok) break;
    const html = await res.text();

    // ClinchTalent job links observed as: <a href="/jobs/{slug}">{title}</a>
    const linkPattern = /<a[^>]+href="(\/jobs\/([a-z0-9-]+))"[^>]*>([^<]+)</gi;
    let match;
    let foundOnPage = 0;
    while ((match = linkPattern.exec(html)) !== null) {
      const [, path, slug, titleRaw] = match;
      // Skip obvious non-job links that happen to match (e.g. "/jobs/search" itself)
      if (slug === "search") continue;
      foundOnPage++;
      rawJobs.push({ path, slug, title: titleRaw.trim() });
    }
    console.log(`    ...page ${page}: ${foundOnPage} listing(s) found (${rawJobs.length} total so far)`);

    if (foundOnPage === 0) break;
  }

  const seen = new Set();
  const deduped = rawJobs.filter((j) => {
    if (seen.has(j.slug)) return false;
    seen.add(j.slug);
    return true;
  });

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
 * Convert one raw scraped ClinchTalent job into ROOK's canonical job shape.
 */
function normalizeClinchTalentJob(raw, employer) {
  const base = `https://${employer.ats_identifier}`;
  const jobUrl = `${base}${raw.path}`;

  // Best-effort description extraction — tries a couple of common
  // ClinchTalent markup patterns; falls back to just the title if none
  // match. See file header re: this being unverified against raw source.
  const descMatch =
    raw.detailHtml.match(/<div[^>]*class="[^"]*(?:job-description|jobDescription|content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    raw.detailHtml.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  const descriptionHtml = descMatch ? descMatch[1] : "";

  return {
    source_job_id: raw.slug,
    employer_id: employer.id,
    source_type: "clinchtalent",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: employer.company_name,
    description_html: descriptionHtml || null,
    description_text: stripHtml(descriptionHtml || raw.title),
    location_raw: "", // not reliably parseable from the list page alone — same limitation as TalentBrew
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchClinchTalentJobs, normalizeClinchTalentJob };
