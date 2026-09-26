// JazzHR / ApplyToJob public job-board adapter
//
// JazzHR hosts employer career pages at {slug}.applytojob.com.
// The public JSON API is unauthenticated (same one the careers page calls):
//   GET https://{slug}.applytojob.com/apply/jobs/
//   Returns a JSON array of open positions.
//
// Store the subdomain slug in employers.ats_identifier, e.g.:
//   "instinctscience"    → instinctscience.applytojob.com
//   "syncromune"         → syncromune.applytojob.com
//
// NOTE: JazzHR does not officially document this public endpoint.
// It's the feed their own embeddable widget calls. Built from observed
// request/response shapes; treat the first real ingestion run as the
// real validation.

const { titleLooksRelevantWithDiagnostics: titleLooksRelevant } = require('../titleFilterDiagnostics');

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

function normalizeJazzJob(raw, employer) {
  const title     = raw.title || raw.Title || '';
  const city      = raw.city || raw.City || '';
  const state     = raw.state || raw.State || '';
  const location  = [city, state].filter(Boolean).join(', ');
  const reqId     = raw.id || String(Math.random());
  const applyUrl  = raw.applyUrl || raw.apply_url
    || `https://${employer.ats_identifier}.applytojob.com/apply/${reqId}`;
  const postDate  = raw.postingDate || raw.date || null;
  const desc      = raw.description || raw.jobDescription || '';

  return {
    source_job_id:    `jazzhr-${employer.ats_identifier}-${reqId}`,
    source_type:      'career_site',
    source_url:       applyUrl,
    application_url:  applyUrl,
    title_original:   title,
    company_name:     employer.company_name,
    employer_id:      employer.id,
    description_html: desc,
    description_text: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    location_raw:     location || raw.location || '',
    employment_type:  raw.employmentType || raw.type || null,
    date_posted:      postDate ? new Date(postDate).toISOString().split('T')[0] : null,
    status:           'active',
    source_verified:  true,
  };
}

async function fetchJazzHRJobs(employer) {
  const slug = employer.ats_identifier;
  if (!slug) throw new Error(`JazzHR ats_identifier (slug) missing for ${employer.company_name}`);

  const url = `https://${slug}.applytojob.com/apply/jobs/`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`JazzHR fetch failed: ${res.status} for ${employer.company_name}`);

  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch {
    const { fetchListings, detailFields, jobPosting } = require('./htmlSource');
    const raw = await fetchListings(url, u => u.pathname.match(/^\/apply\/(?:jobs\/details\/)?([^/]+)(?:\/|$)/)?.[1]);
    const jobs = raw.map(row => {
      const fields = detailFields(row.detailHtml, '.job_description', '.job-location');
      const ld = jobPosting(row.detailHtml);
      return normalizeJazzJob({ id: row.jobId, title: row.title, description: fields.description, location: fields.location, applyUrl: ld?.url || row.url, date: fields.date }, employer);
    });
    jobs.incompleteSnapshot = raw.incompleteSnapshot;
    return jobs;
  }
  const jobs = Array.isArray(data) ? data : (data.jobs || data.Jobs);
  if (!Array.isArray(jobs)) throw new Error('JazzHR response has no recognized jobs array');
  if (jobs.some(j => !j.id || !(j.title || j.Title))) throw new Error('JazzHR job lacks stable identity or title');
  return jobs.map(j => normalizeJazzJob(j, employer)).filter(j => titleLooksRelevant(j.title_original, j));

}

module.exports = { fetchJazzHRJobs };
