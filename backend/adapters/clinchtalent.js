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
const cheerio = require('cheerio');

function listingLinks(html, base) {
  const $ = cheerio.load(html);
  const jobs = [];
  $('a[href]').each((_, anchor) => {
    let url;
    try { url = new URL($(anchor).attr('href'), base); } catch { return; }
    if (url.origin !== base || !/^\/jobs\/[a-z0-9-]+\/?$/i.test(url.pathname)) return;
    if (url.pathname === '/jobs/search') return;
    const title = $(anchor).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    const row = $(anchor).closest('tr');
    const location = row.find('[id^="location_"]').first().text().replace(/\s+/g, ' ').trim();
    jobs.push({ path: url.pathname, slug: url.pathname.split('/').filter(Boolean).pop(), title, location });
  });
  return jobs;
}

function jobPostingData(html) {
  const $ = cheerio.load(html);
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const value = JSON.parse($(script).html());
      const candidates = Array.isArray(value) ? value : value['@graph'] || [value];
      const posting = candidates.find(item => item && (item['@type'] === 'JobPosting' || item['@type']?.includes?.('JobPosting')));
      if (posting) return posting;
    } catch { /* Invalid optional structured data; use page fallback. */ }
  }
  return null;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ")
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

async function fetchClinchTalentJobs(hostname) {
  const base = `https://${hostname}`;
  const rawJobs = [];
  const maxPages = 20; // safety cap — a 500-posting employer over ~30/page

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${base}/jobs/search` : `${base}/jobs/search?page=${page}`;
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      // A later page failing to even connect doesn't invalidate rows
      // already collected — but the first page failing this way means
      // nothing was collected at all, same as a non-ok response below.
      if (page === 1) throw new Error(`ClinchTalent fetch failed for "${hostname}": ${err.message}`);
      break;
    }
    if (!res.ok) {
      // REFRESH SAFETY: this used to just `break` here on any page,
      // including the first — which meant a blocked page, a 5xx, or a
      // timeout on page 1 produced the exact same rawJobs=[] as a
      // genuinely empty careers page. ingest.js closes every existing
      // job for an employer whose adapter returns zero rows, so a
      // transient failure on page 1 would have silently closed every
      // real posting. Only a later page's failure is safe to swallow
      // (rows from earlier pages are already collected); a first-page
      // failure must fail loudly instead.
      if (page === 1) throw new Error(`ClinchTalent fetch failed for "${hostname}": ${res.status} ${res.statusText}`);
      break;
    }
    const html = await res.text();

    const pageJobs = listingLinks(html, base);
    const foundOnPage = pageJobs.length;
    rawJobs.push(...pageJobs);
    console.log(`    ...page ${page}: ${foundOnPage} listing(s) found (${rawJobs.length} total so far)`);

    if (foundOnPage === 0) {
      // Zero rows on page 1 itself is only safe to treat as a genuine
      // empty result if the page explicitly says so; otherwise it's
      // indistinguishable from a blocked/broken/JS-only response, same
      // reasoning as the SuccessFactors adapter's equivalent guard.
      if (page === 1) {
        const explicitlyEmpty = /no (?:current |open |available )?(?:positions|jobs|openings|vacancies|results) (?:found|available|matching)?/i.test(
          html
        );
        if (!explicitlyEmpty) {
          throw new Error(
            `ClinchTalent "${hostname}" returned no job links and no explicit empty-results text on page 1 — likely blocked or a markup change, not a genuine zero-job result`
          );
        }
      }
      break;
    }
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
  const posting = jobPostingData(raw.detailHtml);
  const descMatch =
    raw.detailHtml.match(/<div[^>]*class="[^"]*(?:job-description|jobDescription|content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    raw.detailHtml.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  const descriptionHtml = posting?.description || (descMatch ? descMatch[1] : "");
  const address = (Array.isArray(posting?.jobLocation) ? posting.jobLocation[0] : posting?.jobLocation)?.address;
  const location = [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', ') || raw.location || '';

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
    location_raw: location,
    date_posted: posting?.datePosted || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchClinchTalentJobs, normalizeClinchTalentJob };
