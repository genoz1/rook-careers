// UKG Pro (formerly UltiPro) public job-board adapter
//
// UKG Pro careers pages are hosted at recruiting.ultipro.com or
// recruiting2.ultipro.com. The public job-listing API is unauthenticated.
//
// URL pattern:
//   https://recruiting[2].ultipro.com/{ORG_CODE}/{display_name}/JobBoard/{board_id}
//
// Public JSON API:
//   POST https://recruiting[2].ultipro.com/{ORG_CODE}/{display_name}/JobBoard/{board_id}/api/apply/jobs/search
//   Body: { "pageSize": 100, "pageNumber": 1, "openings": true }
//
// Store in employers.ats_identifier as: "host|ORG_CODE|board_id"
//   e.g. "recruiting.ultipro.com|GEN1019|bb822312-e746-def8-5d38-36b1544138df"
//   or   "recruiting2.ultipro.com|ARU1000ARUP|62cc791d-612e-42e6-909f-0de27efe2038"
//
// The display_name segment in the path is cosmetic and can be inferred
// from the company slug, but the org code and board ID are the real
// identifiers. The POST endpoint doesn't need the display name — the
// org code and board ID are sufficient.
//
// NOTE: UKG does not officially document this endpoint for third-party
// use. It's the same endpoint UKG's own careers-page widget calls.
// Built from observed request/response shapes; treat the first real
// ingestion run as the real test.

const { titleLooksRelevant } = require('../relevanceFilter');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'ROOK-Medical-Sales-Careers/1.0 (job aggregator; contact@rookcareers.com)',
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const PAGE_SIZE = 100;

function normalizeUkgJob(raw, employer) {
  const title    = raw.Title || raw.title || '';
  const city     = raw.City || raw.city || '';
  const state    = raw.State || raw.state || '';
  const location = [city, state].filter(Boolean).join(', ');
  const reqId    = raw.RequisitionId || raw.Id || String(Math.random());
  const applyUrl = raw.ApplyUrl || employer.source_url;
  const postDate = raw.PostedDate || raw.DatePosted || null;
  const desc     = raw.JobDescription || raw.Description || '';

  return {
    source_job_id:    `ukg-${employer.ats_identifier?.split('|')[2] || employer.company_slug}-${reqId}`,
    source_type:      'career_site',
    source_url:       applyUrl || employer.source_url,
    application_url:  applyUrl || employer.source_url,
    title_original:   title,
    company_name:     employer.company_name,
    employer_id:      employer.id,
    description_html: desc,
    description_text: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    location_raw:     location || raw.LocationDescription || '',
    employment_type:  raw.EmploymentType || null,
    date_posted:      postDate ? new Date(postDate).toISOString().split('T')[0] : null,
    status:           'active',
    source_verified:  true,
  };
}

async function fetchUkgJobs(employer) {
  // Identifier: "host|ORG_CODE|board_id"
  const parts   = (employer.ats_identifier || '').split('|');
  const host    = parts[0] || 'recruiting.ultipro.com';
  const orgCode = parts[1];
  const boardId = parts[2];

  if (!orgCode || !boardId) {
    throw new Error(`UKG ats_identifier must be "host|ORG_CODE|board_id" for ${employer.company_name}`);
  }

  const jobs = [];
  let page = 1;

  while (true) {
    const url = `https://${host}/${orgCode}/${employer.company_slug}/JobBoard/${boardId}/api/apply/jobs/search`;
    const res = await fetchWithTimeout(url, {
      method:  'POST',
      body:    JSON.stringify({ pageSize: PAGE_SIZE, pageNumber: page, openings: true }),
    });

    if (!res.ok) {
      if (page === 1) throw new Error(`UKG fetch failed: ${res.status} for ${employer.company_name}`);
      break;
    }

    const data = await res.json().catch(() => ({}));
    const pageJobs = data.jobs || data.Jobs || data.results || data.Results || [];
    if (pageJobs.length === 0) break;
    jobs.push(...pageJobs);
    if (pageJobs.length < PAGE_SIZE) break;
    page++;
    await new Promise(r => setTimeout(r, 250));
  }

  return jobs
    .map(j => normalizeUkgJob(j, employer))
    .filter(j => titleLooksRelevant(j.title_original));
}

module.exports = { fetchUkgJobs };
