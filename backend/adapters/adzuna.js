// Adzuna adapter — pulls REAL, currently-live job postings from Adzuna's
// public job search API (developer.adzuna.com). Free tier, self-serve
// signup, no scraping involved — this is Adzuna's own documented,
// licensed API surface.
//
// Used specifically to seed the "Recruiter Jobs" section with real
// staffing/recruiting-agency-sourced listings until real recruiters are
// posting directly through ROOK's own recruiter portal. See
// backend/ingestAdzuna.js for the agency-detection filter and how these
// get tagged distinctly (source_type='agency_aggregated') from native
// ROOK recruiter postings (source_type='recruiter_posted') — the two are
// NOT the same thing and must not be treated identically: an
// agency_aggregated job has no real recruiter_email on file, so it must
// always link out to its real Adzuna redirect_url to apply, never
// through ROOK's in-site Apply flow (which requires a real recruiter
// contact to email).

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;

async function fetchAdzunaJobs(keyword, page = 1, resultsPerPage = 50) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY not set — sign up free at developer.adzuna.com and add both to your environment variables.");
  }
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/us/search/${page}`);
  url.searchParams.set("app_id", ADZUNA_APP_ID);
  url.searchParams.set("app_key", ADZUNA_APP_KEY);
  url.searchParams.set("results_per_page", String(resultsPerPage));
  url.searchParams.set("what", keyword);
  url.searchParams.set("content-type", "application/json");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Adzuna API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.results || [];
}

function normalizeAdzunaJob(raw) {
  return {
    source_job_id: String(raw.id),
    source_type: "agency_aggregated",
    source_url: raw.redirect_url || null,
    application_url: raw.redirect_url || null,
    title_original: raw.title || "",
    company_name: raw.company?.display_name || null,
    location_raw: raw.location?.display_name || null,
    description_text: raw.description || null,
    salary_min: raw.salary_min ? Math.round(raw.salary_min) : null,
    salary_max: raw.salary_max ? Math.round(raw.salary_max) : null,
    compensation_text: raw.salary_min && raw.salary_max
      ? `$${Math.round(raw.salary_min).toLocaleString()} – $${Math.round(raw.salary_max).toLocaleString()}${raw.salary_is_predicted === "1" ? " (est.)" : ""}`
      : null,
    date_posted: raw.created ? raw.created.slice(0, 10) : null,
    status: "active",
    // moderation_status left unset — schema default is 'approved', same
    // as every other externally-sourced (non-recruiter-submitted) job.
  };
}

module.exports = { fetchAdzunaJobs, normalizeAdzunaJob };
