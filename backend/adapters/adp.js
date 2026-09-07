// ADP Workforce Now public job-board adapter
//
// ADP Workforce Now careers pages are client-side rendered, but the
// underlying JSON feed they call is public and unauthenticated. Each
// employer has a unique CID (client ID) that appears in their careers URL:
//   https://workforcenow.adp.com/mascsr/default/mdf/recruitment/
//     recruitment.html?ccId=19000101_000001&cid={CID}&lang=en_US
//
// The public JSON endpoint is:
//   GET https://workforcenow.adp.com/mascsr/default/mdf/recruitment/
//     recruitment.html?ccId=19000101_000001&cid={CID}&lang=en_US
//     &type=2&v=1&jobPipelineId=&count=25&offset={offset}
//
// Store the CID in employers.ats_identifier, e.g.:
//   "3b6256c1-2a46-4436-9cdb-bc5511fc6ab2"
//
// This also handles the legacy ADP Recruiting format:
//   https://recruiting.adp.com/srccar/public/RTI.home?c={code}&d={domain}
// For those, store as "recruiting:{code}:{domain}"
//
// NOTE: ADP's public career-site API is not officially documented for
// third-party use. The endpoint is the same one ADP's own widget calls,
// identifiable via browser devtools on any ADP-hosted careers page.
// Built from observed request/response shapes; treat the first real
// ingestion run as the real validation.

const { titleLooksRelevant } = require('../relevanceFilter');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ROOK-Medical-Sales-Careers/1.0 (job aggregator; contact@rookcareers.com)',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ADP Workforce Now public JSON endpoint
const WFN_BASE = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html';
const PAGE_SIZE = 25;

function normalizeAdpJob(raw, employer) {
  // ADP WFN job shape (observed from browser devtools on WFN careers pages)
  const title    = raw.jobTitle || raw.title || '';
  const location = [raw.jobLocation?.cityName, raw.jobLocation?.stateCode]
    .filter(Boolean).join(', ');
  const applyUrl = raw.applyURL || raw.apply_url || employer.source_url;
  const postDate = raw.postingDate || raw.createDate || null;
  const jobDesc  = raw.jobDescription?.text || raw.description || '';
  const reqId    = raw.jobRequisitionId || raw.id || String(Math.random());

  return {
    source_job_id:    `adp-${employer.ats_identifier}-${reqId}`,
    source_type:      'career_site',
    source_url:       applyUrl || employer.source_url,
    application_url:  applyUrl || employer.source_url,
    title_original:   title,
    company_name:     employer.company_name,
    employer_id:      employer.id,
    description_html: jobDesc,
    description_text: jobDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    location_raw:     location || raw.jobLocation?.countryCode || '',
    employment_type:  raw.employmentType || null,
    date_posted:      postDate ? new Date(postDate).toISOString().split('T')[0] : null,
    status:           'active',
    source_verified:  true,
  };
}

async function fetchAdpJobs(employer) {
  const identifier = employer.ats_identifier || '';

  // Legacy ADP Recruiting format (recruiting.adp.com)
  if (identifier.startsWith('recruiting:')) {
    const [, code, domain] = identifier.split(':');
    const url = `https://recruiting.adp.com/srccar/public/RTI.home?c=${code}&d=${domain}&type=2&lang=en_US&v=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`ADP Recruiting fetch failed: ${res.status} for ${employer.company_name}`);
    const data = await res.json().catch(() => ({}));
    const listings = data.jobList || data.jobs || data.items || [];
    return listings
      .map(j => normalizeAdpJob(j, employer))
      .filter(j => titleLooksRelevant(j.title_original));
  }

  // ADP Workforce Now — paginated
  const cid = identifier;
  const jobs = [];
  let offset = 0;

  while (true) {
    const url = `${WFN_BASE}?ccId=19000101_000001&cid=${cid}&lang=en_US&type=2&v=1&count=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (offset === 0) throw new Error(`ADP WFN fetch failed: ${res.status} for ${employer.company_name}`);
      break; // partial data is better than nothing after the first page
    }
    const data = await res.json().catch(() => ({}));
    const page = data.jobList || data.jobs || data.items || data.data || [];
    if (page.length === 0) break;
    jobs.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise(r => setTimeout(r, 250));
  }

  return jobs
    .map(j => normalizeAdpJob(j, employer))
    .filter(j => titleLooksRelevant(j.title_original));
}

module.exports = { fetchAdpJobs };
