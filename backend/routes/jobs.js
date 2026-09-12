// Public job-listing routes. Auth is optional here: signed-out visitors
// can browse jobs same as before, but a signed-in candidate sees their
// PRECOMPUTED match scores — see backend/scoring/precompute.js and
// backend/precomputeScores.js.
//
// This used to call scoreJob() live, fetching a pool of jobs (originally
// 20, later raised to 1,500) and scoring only that pool before deciding
// what to show. At real scale that pool size becomes a real ceiling — a
// candidate's genuinely best match could sit outside it and never even
// get considered. Scores are now computed ahead of time by a scheduled
// job and stored in candidate_job_matches, so a request here just reads
// already-scored rows sorted by score directly from the database. No
// pool size to outgrow, genuinely unbounded by job volume.
//
// Auth model: same as profile.js — verify the caller's token with the
// ANON client, then look up their profile with the SERVICE ROLE client.
//
// Application/dismissal awareness: jobs a candidate has dismissed are
// filtered out of results entirely; jobs they've saved or applied to are
// annotated so the frontend can show the right button state.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { scoreJob, mentionsNonUsCountry, hasFullAccess, stateAbbrFromName } = require("../matching");
const { fetchActiveJobs } = require("../scoring/precompute");
const { distanceMiles, geocodeZip } = require("../geocoding");
const { sendEmail } = require("../email/resend");

function escapeHtmlServer(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const router = express.Router();

const isConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured) {
    return res.status(503).json({ error: "Supabase isn't configured on this server yet. See ROOK-Setup-Guide.pdf." });
  }
  next();
}

async function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return next();
  const { data } = await supabaseAnon.auth.getUser(token);
  if (data?.user) req.user = data.user;
  next();
}

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = data.user;
  next();
}

async function loadCandidateId(req, res, next) {
  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Complete onboarding first" });
  req.candidateId = data.id;
  next();
}

// Real, exact distance in miles — separate from the coarse tiered credit
// scoreJob() gives location within Preference Fit. Attached to every job
// result so the frontend can offer a real "Closest to You" sort without
// distorting the fit score itself (see conversation: Location &
// Preferences was doing double duty as both a geographic-acceptability
// gate and a fine-grained proximity signal — pulling raw distance out
// into its own field, sortable independently, resolves that).
// Reported directly as slow job loading (~5 seconds even after the
// candidate_job_matches index fix). Every job-listing query below used
// to pull every column via jobs(*) / jobs!inner(*) - including
// job_embedding, a 1536-dimension vector that's only ever WRITTEN
// (during ingestion/recruiter posting) and never read back anywhere in
// any API response or the frontend. With the job pool having roughly
// doubled tonight and list views routinely requesting up to 300 rows
// at once, that's real, unnecessary data being fetched from Postgres
// and serialized on every single load for a field nothing ever uses.
// This explicit column list is every real column on jobs EXCEPT
// job_embedding, kept as one shared constant so every listing query
// gets the fix, not just the one that happened to get reported.
const JOB_LIST_COLUMNS = "id, source_job_id, employer_id, source_type, source_url, application_url, title_original, title_normalized, company_name, description_html, description_text, ai_analysis, location_raw, job_lat, job_lng, city, state, region, territory, remote_status, employment_type, category, subcategory, industry, product_type, sales_type, experience_min_years, experience_max_years, salary_min, salary_max, compensation_text, travel_percentage, overnight_travel, required_skills, preferred_skills, required_experience, preferred_experience, degree_required, certifications, date_posted, first_seen_at, last_seen_at, status, source_verified, moderation_status, recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, recruiter_id, created_at, updated_at";
const JOB_LIST_COLUMNS_NO_DESCRIPTION = JOB_LIST_COLUMNS.split(", ").filter((c) => c !== "description_html" && c !== "description_text").join(", ");

function attachDistance(job, profile) {
  const hasCoords = profile?.home_lat != null && profile?.home_lng != null && job.job_lat != null && job.job_lng != null;
  return {
    ...job,
    distance_miles: hasCoords ? Math.round(distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng)) : null,
  };
}

function matchFromRow(row) {
  return {
    overall_score: row.overall_score,
    candidate_fit: row.candidate_fit,
    preference_fit: row.preference_fit,
    recommendation: row.recommendation,
    reasons: row.reasons || [],
    concerns: row.concerns || [],
    confidence: row.confidence,
    hard_disqualifier: row.hard_disqualifier,
    categories: row.categories || null,
    excellent_match: Boolean(row.excellent_match),
  };
}

// The actual paywall: a signed-in candidate without full access (no
// active trial or paid subscription) still sees their REAL match
// score, reasons, and every other job detail — that's what makes the
// paywall worth paying past, unlike the anonymous teaser, which hides
// that too. Only the employer's identity and the real way to apply are
// withheld, the same two fields gated from anonymous visitors.
// subscription_status is written by the Stripe webhook
// (backend/routes/stripe.js). Gating decision itself moved to
// matching.js's hasFullAccess() — centralized there so every gate in
// the app (Dashboard, Job Search, saved jobs, job detail, and the
// daily digest) uses the exact same definition of "full access," which
// now includes a trialing candidate as well as an actively paying one.
// See that file's comment for the reasoning.

// Escapes regex special characters in a company name before using it in
// a pattern — company names can contain characters like "." or "+"
// (e.g. "3M", "C.R. Bard") that would otherwise be interpreted as regex
// syntax instead of literal text.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces every occurrence of the employer's name in a block of text
// with a neutral placeholder. Real bug this fixes: company_name was
// being stripped from the job OBJECT for non-subscribers, but the raw
// description_text almost always names the employer in its own opening
// sentence ("Medtronic is a global leader in...") — completely
// defeating the redaction, since the name was sitting in plain sight a
// few lines below the "Employer hidden" badge. This catches the base
// name regardless of legal-suffix variations ("Medtronic Inc.",
// "Medtronic Corporation") since those still contain the base name as
// a substring.
// Common legal-entity suffixes that are never worth scrubbing on their
// own — "Inc" or "LLC" alone doesn't identify who the employer is, and
// treating them as significant words would create a lot of pointless
// replacements throughout ordinary text.
const COMPANY_SUFFIX_WORDS = new Set([
  "inc", "inc.", "llc", "llc.", "corp", "corp.", "corporation", "co", "co.",
  "company", "ltd", "ltd.", "limited", "group", "holdings", "the", "of",
]);

function scrubCompanyNameFromText(text, companyName) {
  if (!text || !companyName) return text;
  let result = text.replace(new RegExp(escapeRegex(companyName), "gi"), "this employer");

  // Real gap this closes: matching only the exact full stored
  // company_name misses the very common case where a job posting's own
  // description text refers to the employer by a shorter form of its
  // name than what's stored in the database — e.g. company_name is
  // "Caris Life Sciences" but the posting's own text says "At Caris,
  // we understand..." Reported directly: the listing page still showed
  // "At Caris" in a preview even after the exact-match scrub was
  // working correctly on the job detail page. Scrubbing each
  // significant standalone word from the company name too (skipping
  // short/common legal-suffix words) catches this without needing to
  // guess every possible abbreviated form in advance.
  //
  // Reported directly, a second gap: a company known by a short
  // all-caps acronym/brand (e.g. "MWI", for MWI Animal Health) leaked
  // straight through in a job TITLE ("Regional Manager - MWI") even
  // after this fix, because "MWI" is only 3 characters and the
  // length-based filter below exists specifically to skip short,
  // common, non-identifying words (like "of" or "co") — it wasn't
  // meant to also exclude a genuinely identifying short acronym. An
  // all-caps token is treated as identifying regardless of length,
  // since ordinary English words this short are essentially never
  // fully capitalized in normal text.
  const words = companyName.split(/\s+/).filter((w) => {
    const letters = w.replace(/[^a-zA-Z]/g, "");
    if (COMPANY_SUFFIX_WORDS.has(w.toLowerCase())) return false;
    if (letters.length > 3) return true;
    return letters.length >= 2 && letters === letters.toUpperCase();
  });
  for (const word of words) {
    result = result.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, "gi"), "this employer");
  }
  return result;
}

function redactForNonSubscriber(job) {
  const {
    company_name, source_url, application_url,
    recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, // same gate applies to recruiter postings
    description_text, description_preview,
    title_original, title_normalized,
    ...rest
  } = job;
  const scrubbedFullText = scrubCompanyNameFromText(description_text, company_name);
  return {
    ...rest,
    // Real gate bypass this closes: a job's TITLE can name the employer
    // directly (e.g. "Regional Manager - MWI"), and neither this
    // function nor its callers ever touched title_original/
    // title_normalized before now — every other field was gated, but
    // the title was shown completely unredacted to every non-subscribed
    // and anonymous viewer regardless. Reported directly with a real
    // example. Falls back to the original title only when scrubbing
    // isn't possible (no company_name on file) rather than showing
    // nothing.
    title_original: scrubCompanyNameFromText(title_original, company_name) ?? title_original,
    title_normalized: scrubCompanyNameFromText(title_normalized, company_name) ?? title_normalized,
    description_text: scrubbedFullText,
    description_preview: scrubCompanyNameFromText(description_preview, company_name) ?? (scrubbedFullText ? scrubbedFullText.slice(0, 300) : undefined),
    subscription_required: true,
  };
}

// Stricter than redactForNonSubscriber: an anonymous visitor has no
// account at all, so on top of the usual company/apply-link redaction,
// this also strips the match score, recommendation, categories,
// reasons, and concerns entirely. Direct instruction: "mask the job
// details so when the customer actually signs up its the same
// format" — same card layout and same real scoreJob()-driven ranking
// as a signed-in candidate would see, just with everything that would
// reveal the fit or the employer removed rather than shown for free.
function redactForAnonymous(job) {
  const withCompanyRedacted = redactForNonSubscriber(job);
  const { match, ...rest } = withCompanyRedacted;
  return rest;
}

// PERFORMANCE (2026-09, investigated per direct audit finding —
// dashboard matches stuck on "Loading" for 25+ seconds): scoreJob()
// itself reads job.description_text for its own scoring logic (see
// backend/matching.js), so description_text must stay in the SELECT
// query and can't be dropped there. But no frontend consumer of this
// endpoint's response ever reads description_text, description_html,
// or description_preview from a LIST result — confirmed by checking
// every page that calls GET /jobs (rook-dashboard.html,
// rook-browse.html, rook-job-analysis.html use none of them; the
// separate GET /jobs/:id route serves the job-detail page instead,
// with its own independent query, untouched by this). For a full
// dashboard load that's up to 300 jobs' worth of full HTML+text
// descriptions - often several KB each - serialized into JSON,
// transferred over the wire, and parsed by the browser for content
// that is then simply never rendered. This strips those three fields
// from the response AFTER scoring has already used them, so match
// scores, reasons, and ranking are entirely unaffected - only the
// unused payload size changes.
function stripUnusedDescriptionFields(job) {
  const { description_html, description_text, description_preview, ...rest } = job;
  return rest;
}

// Builds the employer_note map (spec factor #43, employer-history
// awareness) — unrelated to match scoring, still computed live here
// since it's a small, fast query, not something worth precomputing.
async function loadEmployerHistory(candidateId) {
  const { data: appRows } = await supabaseAdmin
    .from("applications")
    .select("job_id, status, jobs(employer_id, title_original)")
    .eq("candidate_id", candidateId);

  const appStatusByJob = new Map((appRows || []).map((a) => [a.job_id, a.status]));
  const employerHistory = new Map();
  for (const app of appRows || []) {
    const employerId = app.jobs?.employer_id;
    if (!employerId) continue;
    if (!employerHistory.has(employerId)) employerHistory.set(employerId, []);
    employerHistory.get(employerId).push({ title: app.jobs.title_original, status: app.status, job_id: app.job_id });
  }

  function noteFor(job) {
    const priorAtEmployer = (employerHistory.get(job.employer_id) || []).filter((a) => a.job_id !== job.id);
    if (priorAtEmployer.length === 0) return null;
    const rejected = priorAtEmployer.find((a) => a.status === "rejected");
    const active = priorAtEmployer.find((a) => a.status !== "rejected" && a.status !== "withdrawn");
    if (active) return `You have an application in progress at this company for "${active.title}"`;
    if (rejected) return `You were previously not selected for "${rejected.title}" at this company`;
    return "You've previously applied to this company";
  }

  return { appStatusByJob, noteFor };
}

// GET /api/public-job-count — a single fast count, no job rows, no
// geolocation, no sorting. Built specifically so the homepage (and any
// other marketing page) can show the real "X opportunities currently
// tracked" number as a credibility signal without paying the cost of
// the full /jobs anonymous-browse query, which always fetches up to
// 200 real job rows plus does an IP geolocation lookup even when a
// caller only wants the headline number.
router.get("/public-job-count", requireConfig, async (req, res) => {
  const { count, error } = await supabaseAnon
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("moderation_status", "approved");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ total_count: count || 0 });
});

// GET /api/public-employer-count — same pattern as /public-job-count
// above: a single fast count for the homepage's "Direct integrations
// with N employers" line. Counts distinct employer_id values with at
// least one active, approved job right now, not every row ever
// inserted into the employers table over time — a company that was
// onboarded once but currently has zero live postings shouldn't count
// toward "employers we're sourcing from right now."
router.get("/public-employer-count", requireConfig, async (req, res) => {
  const { data, error } = await supabaseAnon
    .from("jobs")
    .select("employer_id")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .not("employer_id", "is", null);
  if (error) return res.status(500).json({ error: error.message });
  const uniqueEmployers = new Set((data || []).map((row) => row.employer_id));
  res.json({ total_count: uniqueEmployers.size });
});

// GET /api/public-geocode-zip?zip=32162 — anonymous-safe ZIP-to-
// coordinates lookup for the Find Jobs page's "enter your ZIP" prompt.
// Direct instruction: browser geolocation and IP-based geolocation have
// both proven unreliable in practice for this page (permission denial,
// a browser silently remembering an earlier denial, or the outbound
// IP-lookup call failing) - a visitor-entered ZIP has no such failure
// mode, since it doesn't depend on any permission prompt or third-party
// service being reachable from wherever this app happens to be hosted.
// Reuses geocodeZip() exactly as-is (same function already used when a
// candidate saves their ZIP in Settings) rather than a second
// geocoding implementation that could drift from it.
router.get("/public-geocode-zip", requireConfig, async (req, res) => {
  const zip = String(req.query.zip || "").trim();
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: "Enter a valid 5-digit ZIP code." });
  const coords = await geocodeZip(zip);
  if (!coords) return res.status(404).json({ error: "Could not find that ZIP code." });
  res.json(coords);
});

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, optionalAuth, async (req, res) => {
  const { industry, state, limit = 20, keyword } = req.query;

  // Anonymous browsing. Direct instruction: "copy the job search page
  // [...] and mask the job details so when the customer actually
  // signs up it's the same format" — this reuses the EXACT same
  // bounding-box + scoreJob() logic as the authenticated near_lat/
  // near_lng "explore a location" path just below (not a second,
  // separate reimplementation that could drift from it), scored
  // against a minimal synthetic profile built from a ZIP the visitor
  // typed themselves (see rook-browse.html — no browser geolocation,
  // no IP lookup, no auto-detection of any kind). The only difference
  // from the signed-in experience is what the RESPONSE hides
  // (redactForAnonymous strips company/apply-link AND the match score
  // itself), not how the ranking is computed.
  if (!req.user) {
    // Real total count of active+approved jobs platform-wide, not just
    // however many this request happens to fetch. Reported real bug:
    // the public browse page was showing "30 open roles" — the literal
    // request's ?limit=30 value, not the actual database size (~2,500
    // real active jobs) — which made the whole platform look far
    // thinner than it actually is right at the moment meant to convince
    // someone to pay.
    const { count: totalCount } = await supabaseAnon
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .eq("moderation_status", "approved");

    const nearLat = req.query.near_lat != null ? Number(req.query.near_lat) : null;
    const nearLng = req.query.near_lng != null ? Number(req.query.near_lng) : null;
    // Full state name (e.g. "Florida"), as returned by geocodeZip — lets
    // the no-coordinates fallback below match jobs by state the same
    // way it would for a signed-in candidate with a real home_state,
    // instead of skipping that branch entirely for every anonymous
    // visitor.
    const nearStateName = typeof req.query.near_state === "string" ? req.query.near_state : null;

    if (nearLat == null || nearLng == null || Number.isNaN(nearLat) || Number.isNaN(nearLng)) {
      // The normal state for a first-time visitor now — the ZIP box on
      // the frontend is a persistent, optional part of the page rather
      // than a mandatory gate, so plenty of requests will genuinely
      // have no location yet. Falls back to a plain recency-ordered,
      // redacted list rather than erroring or showing nothing.
      let fallbackQuery = supabaseAnon
        .from("jobs")
        .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
        .eq("status", "active")
        .eq("moderation_status", "approved")
        .order("date_posted", { ascending: false })
        .limit(Number(limit));
      if (industry) fallbackQuery = fallbackQuery.eq("industry", industry);
      if (state) fallbackQuery = fallbackQuery.eq("state", state);
      const { data: fallbackJobs, error: fallbackError } = await fallbackQuery;
      if (fallbackError) return res.status(500).json({ error: fallbackError.message });
      const usOnly = (fallbackJobs || []).filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original));
      return res.json({ jobs: usOnly.map(redactForAnonymous).map(stripUnusedDescriptionFields), total_count: totalCount || 0, explored_location: false });
    }

    const EXPLORE_RADIUS_MILES = 300; // same constant as the authenticated explore path below — one radius, not two to keep in sync
    const latDelta = EXPLORE_RADIUS_MILES / 69;
    const lngDelta = EXPLORE_RADIUS_MILES / (69 * Math.max(0.1, Math.cos((nearLat * Math.PI) / 180)));

    const { data: boxJobs, error: boxError } = await supabaseAnon
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .gte("job_lat", nearLat - latDelta)
      .lte("job_lat", nearLat + latDelta)
      .gte("job_lng", nearLng - lngDelta)
      .lte("job_lng", nearLng + lngDelta);
    if (boxError) return res.status(500).json({ error: boxError.message });

    const nearby = (boxJobs || []).filter((job) => {
      if (job.job_lat == null || job.job_lng == null) return false;
      return distanceMiles(nearLat, nearLng, job.job_lat, job.job_lng) <= EXPLORE_RADIUS_MILES;
    });

    // Same reasoning as the authenticated path: a bounding box can only
    // ever match jobs that HAVE real coordinates — fetched separately so
    // a vague multi-location or never-geocoded posting isn't silently
    // dropped, just scored through scoreJob()'s own honest fallback.
    let noCoordsQuery = supabaseAnon
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .is("job_lat", null);
    if (industry) noCoordsQuery = noCoordsQuery.eq("industry", industry);
    if (state) noCoordsQuery = noCoordsQuery.eq("state", state);
    if (keyword) noCoordsQuery = noCoordsQuery.or(`title_original.ilike.%${keyword}%,company_name.ilike.%${keyword}%`);
    const { data: noCoordsJobs, error: noCoordsError } = await noCoordsQuery;
    if (noCoordsError) return res.status(500).json({ error: noCoordsError.message });

    // The synthetic profile a visitor's ZIP produces — home_lat/lng and
    // home_state only. Every other scoreJob() field (résumé, industries,
    // salary floor, willing_to_relocate) is simply absent, which
    // scoreJob already handles safely everywhere it's read.
    const anonymousProfile = { home_lat: nearLat, home_lng: nearLng, home_state: nearStateName };
    let scored = [...nearby, ...(noCoordsJobs || [])]
      .filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original))
      .map((job) => ({ ...job, match: scoreJob(job, anonymousProfile) }))
      .filter((job) => industry ? job.industry === industry : true)
      .filter((job) => state ? job.state === state : true)
      .sort((a, b) => (b.match?.overall_score ?? -1) - (a.match?.overall_score ?? -1));
    if (!keyword) scored = scored.slice(0, Number(limit));

    const results = scored.map((job) => ({
      ...attachDistance(job, anonymousProfile),
      match: job.match,
    }));

    return res.json({ jobs: results.map(redactForAnonymous).map(stripUnusedDescriptionFields), total_count: totalCount || 0, explored_location: true });
  }

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile) {
    // No profile yet at all (onboarding not completed) — nothing to
    // score against. Same as before: fall back to the plain job list.
    // No scoreJob() call happens in this branch at all, so unlike the
    // scored branches below, description_text isn't even needed in
    // the query here — excluded directly rather than fetched and
    // stripped afterward.
    let query = supabaseAnon.from("jobs").select(JOB_LIST_COLUMNS_NO_DESCRIPTION).eq("status", "active").eq("moderation_status", "approved").order("date_posted", { ascending: false }).limit(Number(limit));
    if (industry) query = query.eq("industry", industry);
    if (state) query = query.eq("state", state);
    const { data } = await query;
    return res.json(data);
  }

  // "Explore a different location" — Job Search's "Show jobs near"
  // field, when it's been pointed somewhere other than the candidate's
  // own saved home ZIP (e.g. considering a move to Chicago while
  // actually living in Florida). Reported directly: this used to just
  // re-filter the candidate's own top-300 PRECOMPUTED matches
  // client-side, which are scored relative to their real home location
  // - so a candidate whose own top matches are all nearby (increasingly
  // true now that distance scoring is stricter) would see zero results
  // near a genuinely different city, even though real jobs exist there,
  // because those jobs never scored high enough against their REAL
  // location to make the initial top-300 cut at all.
  //
  // candidate_job_matches is inherently tied to the candidate's actual
  // home_lat/home_lng (that's what the scheduled precompute job scores
  // against), so satisfying this properly means live-scoring here
  // instead of reading that table - deliberately scoped to jobs
  // roughly near the explored location first (cheap distance check
  // before the real scoring pass), not the full active-jobs table,
  // since scoring every job nationwide for a single search would be
  // wasteful when only a few hundred are ever going to be geographically
  // relevant to what was actually asked.
  // Direct instruction: "just copy the job search page and lock the zip
  // code into wherever the customer's zip code is on their profile."
  // Defaults near_lat/near_lng to the candidate's own real home
  // coordinates when neither is explicitly given, so this becomes the
  // literal same, already-proven-correct code path for BOTH an explicit
  // "show jobs near X" search AND the default candidate-facing view -
  // not a second, separate reimplementation of the same idea that could
  // (and did) drift from it in some subtle way. One path, one set of
  // bugs to ever find, not two.
  const nearLat = req.query.near_lat != null ? Number(req.query.near_lat) : profile.home_lat;
  const nearLng = req.query.near_lng != null ? Number(req.query.near_lng) : profile.home_lng;
  // If near_lat/near_lng matches the user's home location (within 0.01°),
  // use precomputed scores for instant load. Only use live scoring when
  // the user is genuinely exploring a different location.
  const isHomeLocation = profile.home_lat != null &&
    Math.abs(nearLat - profile.home_lat) < 0.01 &&
    Math.abs(nearLng - profile.home_lng) < 0.01;

  if (nearLat != null && nearLng != null && !Number.isNaN(nearLat) && !Number.isNaN(nearLng) && !isHomeLocation) {
    const EXPLORE_RADIUS_MILES = 300;
    // Reported directly as genuinely slow: fetching ALL ~2,500+ active
    // jobs via fetchActiveJobs (paginated, full columns) and THEN
    // filtering by distance in JS meant paying the cost of the entire
    // table on every single location search, when only a few hundred
    // rows are ever geographically relevant. A simple lat/lng bounding
    // box pushes that filtering down into the actual database query
    // instead - approximate (a box isn't a true circle, so a handful of
    // corner cases slightly outside the real radius can slip in; the
    // exact per-job distanceMiles() filter below still trims those),
    // but cuts the fetched row count dramatically for a real speed win.
    // 1 degree latitude is ~69 miles everywhere; 1 degree longitude
    // shrinks toward the poles, hence the cos(latitude) term.
    const latDelta = EXPLORE_RADIUS_MILES / 69;
    const lngDelta = EXPLORE_RADIUS_MILES / (69 * Math.max(0.1, Math.cos((nearLat * Math.PI) / 180)));

    const { data: boxJobs, error: boxError } = await supabaseAdmin
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .gte("job_lat", nearLat - latDelta)
      .lte("job_lat", nearLat + latDelta)
      .gte("job_lng", nearLng - lngDelta)
      .lte("job_lng", nearLng + lngDelta);
    if (boxError) return res.status(500).json({ error: boxError.message });

    const nearby = (boxJobs || []).filter((job) => {
      if (job.job_lat == null || job.job_lng == null) return false;
      return distanceMiles(nearLat, nearLng, job.job_lat, job.job_lng) <= EXPLORE_RADIUS_MILES;
    });

    // A lat/lng bounding box can only ever match jobs that HAVE real
    // coordinates - a genuinely remote role, or a vague multi-location
    // posting that never successfully geocoded, would be silently
    // dropped entirely rather than shown (even far down the list) if
    // this were the only query run. Fetched separately since a NULL
    // column can't be bounded by range; scoreJob()'s own fallback path
    // (state-text-matching, or a flat remote credit) already applies an
    // honest, non-inflated distanceMultiplier to these - same as the
    // real-coordinates case above, just without an exact mile figure.
    let noCoordsQuery = supabaseAdmin
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .is("job_lat", null);
    if (industry) noCoordsQuery = noCoordsQuery.eq("industry", industry);
    if (state) noCoordsQuery = noCoordsQuery.eq("state", state);
    if (keyword) noCoordsQuery = noCoordsQuery.or(`title_original.ilike.%${keyword}%,company_name.ilike.%${keyword}%`);
    const { data: noCoordsJobs, error: noCoordsError } = await noCoordsQuery;
    if (noCoordsError) return res.status(500).json({ error: noCoordsError.message });

    // Scores against a location-shifted COPY of the real profile — every
    // other preference (industry, comp, experience, exclusions) stays
    // the candidate's own real, actual profile; only the point distance
    // is measured from shifts to the explored location, which is the
    // entire point of "what if I lived here instead."
    const exploredProfile = { ...profile, home_lat: nearLat, home_lng: nearLng };
    let scored = [...nearby, ...(noCoordsJobs || [])]
      .filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original))
      .map((job) => ({ ...job, match: scoreJob(job, exploredProfile) }))
      .filter((job) => industry ? job.industry === industry : true)
      .filter((job) => state ? job.state === state : true)
      .sort((a, b) => (b.match?.overall_score ?? -1) - (a.match?.overall_score ?? -1));
    if (!keyword) scored = scored.slice(0, Number(limit));

    const { appStatusByJob, noteFor } = await loadEmployerHistory(profile.id);
    // saved status lives on candidate_job_matches, which this live-scoring
    // path doesn't read from (it's tied to the candidate's real home
    // location, not the explored one) - a lightweight separate lookup
    // for just the saved job_ids, rather than the full scored rows.
    const { data: savedRows } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("job_id")
      .eq("candidate_id", profile.id)
      .eq("saved", true);
    const savedJobIds = new Set((savedRows || []).map((r) => r.job_id));

    const results = scored.map((job) => ({
      ...attachDistance(job, exploredProfile),
      match: job.match,
      saved: savedJobIds.has(job.id),
      application_status: appStatusByJob.get(job.id) || null,
      employer_note: noteFor(job),
    }));

    return res.json({
      jobs: (hasFullAccess(profile) ? results : results.map(redactForNonSubscriber)).map(stripUnusedDescriptionFields),
      scoring_in_progress: false,
      explored_location: true,
      _debug_marker: "EXPLORE_BRANCH_v1_WITH_NOCOORDS_MERGE",
    });
  }

  // ── Fast path: precomputed scores ─────────────────────────────────────────
  // Read from candidate_job_matches (pre-scored nightly) if scores exist.
  // ── Live scoring — 300-mile bounding box, always fresh ──
  //
  // !! DO NOT REPLACE THIS WITH PRECOMPUTED SCORES !!
  //
  // Precomputed scores were used here previously and caused repeated,
  // hard-to-debug problems:
  //   - Stale industry matching (CMR Pharma scored 94% for Diagnostics users
  //     because its description mentioned 'diagnostics' — stored score never
  //     updated when scoring logic changed)
  //   - Scores stayed wrong until a rescore ran — could be hours or days
  //   - Required complex rescore endpoints, scoring_version tracking,
  //     background refresh logic, and cache invalidation — all fragile
  //
  // The live scoring path fetches ~300-400 jobs via SQL bounding box
  // and scores them in-memory in milliseconds. It is fast enough.
  // Scores are always current. There is no staleness to manage.
  //
  // If you are considering precomputed scores for performance: measure
  // first. The bounding box query is already indexed and fast. Do not
  // reintroduce precomputed scores without explicit written approval
  // from Gene and a full staleness management plan reviewed in advance.
  //
  let liveQuery = supabaseAdmin
    .from("jobs")
    .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
    .eq("status", "active")
    .eq("moderation_status", "approved");
  if (industry) liveQuery = liveQuery.eq("industry", industry);
  if (state) liveQuery = liveQuery.eq("state", state);
  if (keyword) {
    liveQuery = liveQuery.or(`title_original.ilike.%${keyword}%,company_name.ilike.%${keyword}%`);
  }

  // Bounding box pre-filter — cuts Supabase response from 5,000+ rows
  // to ~300-400 before any scoring happens. Applied only when the candidate
  // has a home location; always includes remote and no-coordinate jobs so
  // they're never accidentally excluded. Uses 300-mile box (same radius
  // as the explore path) with a tighter SQL query rather than scoring
  // everything in-memory first.
  if (profile.home_lat != null && profile.home_lng != null && !keyword) {
    const latDelta = 300 / 69;
    const lngDelta = 300 / (69 * Math.max(0.1, Math.cos((profile.home_lat * Math.PI) / 180)));
    liveQuery = liveQuery.or(
      `job_lat.is.null,remote_status.eq.remote,and(job_lat.gte.${profile.home_lat - latDelta},job_lat.lte.${profile.home_lat + latDelta},job_lng.gte.${profile.home_lng - lngDelta},job_lng.lte.${profile.home_lng + lngDelta})`
    );
  }

  const { data: allMatchingJobs, error: liveError } = await liveQuery;
  if (liveError) return res.status(500).json({ error: liveError.message });

  const { data: statusRows } = await supabaseAdmin
    .from("candidate_job_matches")
    .select("job_id, saved, dismissed")
    .eq("candidate_id", profile.id);
  const savedJobIds = new Set((statusRows || []).filter((r) => r.saved).map((r) => r.job_id));
  const dismissedJobIds = new Set((statusRows || []).filter((r) => r.dismissed).map((r) => r.job_id));

  // Title-location sanity check — same as anonymous preview.
  // Filters jobs where stored coordinates are wrong (e.g. "South Florida"
  // job with coordinates near Oxford FL, 49mi away instead of 225mi).
  const TITLE_LOC_CHECKS = {
    'south florida': { lat: 25.9, lng: -80.3 },
    'miami':         { lat: 25.77, lng: -80.19 },
    'fort lauderdale': { lat: 26.12, lng: -80.14 },
    'palm beach':    { lat: 26.71, lng: -80.05 },
    'pensacola':     { lat: 30.42, lng: -87.22 },
    'tallahassee':   { lat: 30.44, lng: -84.28 },
    'jacksonville':  { lat: 30.33, lng: -81.66 },
  };
  function titleLocSanityPass(job) {
    if (!job.job_lat || !profile?.home_lat) return true;
    const title = (job.title_original || '').toLowerCase();
    const computedDist = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
    for (const [kw, coords] of Object.entries(TITLE_LOC_CHECKS)) {
      if (title.includes(kw)) {
        const actual = distanceMiles(profile.home_lat, profile.home_lng, coords.lat, coords.lng);
        if (Math.abs(actual - computedDist) > 80) return false;
      }
    }
    return true;
  }

  // Industry match ratio — used as tiebreaker when overall scores tie.
  // Measures what fraction of a job's product_categories directly match
  // the user's desired industry. BD ['Diagnostics'] = 1.0, Tempus
  // ['Molecular Testing','Genomics'] = 0.5, pure pharma = 0.0.
  // Proxy for candidate_fit when no resume is uploaded — ensures pure
  // diagnostics jobs rank above oncology/genomics-adjacent jobs even
  // without resume data. Does not affect scoring, only tie-breaking.
  const _INDUSTRY_TERMS = {
    diagnostics:      ['diagnostics','reference laboratory','molecular','point-of-care','lab','pathology','clinical laboratory'],
    'medical device': ['medical device','capital equipment','surgical','dme','consumables'],
    pharmaceutical:   ['pharmaceutical','pharma','biotech','life sciences','specialty pharma'],
    veterinary:       ['veterinary','animal health','vet'],
  };
  function _industryMatchRatio(job) {
    const desired = profile.desired_industries || [];
    if (!desired.length) return 0;
    const prodCats = (job.ai_analysis?.product_categories || []).map(s => s.toLowerCase());
    if (!prodCats.length) return 0;
    const terms = desired.flatMap(ind => _INDUSTRY_TERMS[ind.toLowerCase().trim()] || [ind.toLowerCase().trim()]);
    const matched = prodCats.filter(p => terms.some(t => p.includes(t))).length;
    return matched / prodCats.length;
  }

  let rows = (allMatchingJobs || [])
    .filter((job) => !dismissedJobIds.has(job.id))
    .filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original))
    .filter((job) => titleLocSanityPass(job))
    .map((job) => ({ jobs: job, job_id: job.id, overall_score: null, saved: savedJobIds.has(job.id), _liveMatch: scoreJob(job, profile) }))
    .sort((a, b) => {
      const scoreDiff = (b._liveMatch?.overall_score ?? -1) - (a._liveMatch?.overall_score ?? -1);
      if (scoreDiff !== 0) return scoreDiff;
      const ratioDiff = _industryMatchRatio(b.jobs) - _industryMatchRatio(a.jobs);
      if (Math.abs(ratioDiff) > 0.01) return ratioDiff;
      const aDist = a.jobs.job_lat ? distanceMiles(profile.home_lat, profile.home_lng, a.jobs.job_lat, a.jobs.job_lng) : 9999;
      const bDist = b.jobs.job_lat ? distanceMiles(profile.home_lat, profile.home_lng, b.jobs.job_lat, b.jobs.job_lng) : 9999;
      return aDist - bDist;
    });
  if (!keyword) rows = rows.slice(0, Number(limit));

  const { appStatusByJob, noteFor } = await loadEmployerHistory(profile.id);

  const results = rows.map((row) => ({
    ...attachDistance(row.jobs, profile),
    match: row._liveMatch,
    saved: Boolean(row.saved),
    application_status: appStatusByJob.get(row.job_id) || null,
    employer_note: noteFor(row.jobs),
  }));

  return res.json({
    jobs: (hasFullAccess(profile) ? results : results.map(redactForNonSubscriber)).map(stripUnusedDescriptionFields),
    scoring_in_progress: false,
    _debug_marker: "NO_NEAR_LOCATION_FALLBACK_v1",
  });
});

// GET /api/scoring-status — lightweight poll target for a candidate
// whose first-ever /jobs request returned scoring_in_progress: true.
// Just a count comparison, not a re-run of anything, so it's cheap to
// poll every few seconds while the frontend shows a "Building your
// matches" state.
router.get("/scoring-status", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const { count } = await supabaseAdmin
    .from("candidate_job_matches")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", req.candidateId);
  res.json({ ready: Boolean(count && count > 0) });
});

// GET /api/recruiter-jobs — every live recruiter-posted job, independent
// of candidate_job_matches. The main /api/jobs endpoint only returns jobs
// that already have a precomputed score row (inner join on
// candidate_job_matches), so a freshly-approved recruiter posting is
// invisible there until the next scheduled precompute run picks it up —
// reported as a real bug (job approved, confirmed active+approved in the
// DB, still didn't show). Recruiter postings are a small, browsable set
// (not the whole job pool candidates are matched against), so gating
// their visibility on scoring timing doesn't serve any purpose here.
// This queries jobs directly and left-joins a score if one happens to
// already exist, but never requires one.
//
// Includes source_type='agency_aggregated' alongside native
// 'recruiter_posted' jobs — real, live listings pulled from staffing/
// recruiting agencies via backend/ingestAdzuna.js, used to seed this
// section with genuine content until real recruiters are posting
// directly. Frontend must keep treating the two differently for
// "how to apply" (agency_aggregated has no real recruiter_email and
// must link to its real source_url, never ROOK's in-site Apply flow).
router.get("/recruiter-jobs", requireConfig, optionalAuth, async (req, res) => {
  const { data: jobsData, error } = await supabaseAnon
    .from("jobs")
    .select("*")
    .in("source_type", ["recruiter_posted", "agency_aggregated"])
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .order("first_seen_at", { ascending: false })
    .limit(2000); // same latent 1000-row default-cap risk as the scoring query — this stays well ahead of realistic near-term volume, but isn't infinite; revisit if agency-aggregated volume ever approaches it
  if (error) return res.status(500).json({ error: error.message });

  let profile = null;
  if (req.user) {
    const { data } = await supabaseAdmin
      .from("candidate_profiles")
      .select("*")
      .eq("user_id", req.user.id)
      .maybeSingle();
    profile = data;
  }

  let savedByJobId = new Map();
  let appStatusByJob = new Map();
  let noteFor = () => null;
  if (profile) {
    // Reported directly: recruiter-posted/agency jobs were still
    // showing stale scores (same root bug just fixed in scoreJob()
    // itself, but this endpoint read pre-computed rows instead of
    // scoring live) - a Chicago and a Virginia posting both still
    // ranking in the top 10 despite the distance-scoring fix, because
    // this endpoint never actually recomputed anything. Now scores
    // live via scoreJob(), same as the main /jobs endpoint, so this
    // always reflects whatever scoring code is currently deployed
    // rather than depending on a separate precompute run.
    const { data: matchRows } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("job_id, saved")
      .eq("candidate_id", profile.id)
      .in("job_id", jobsData.map((j) => j.id));
    savedByJobId = new Map((matchRows || []).map((r) => [r.job_id, r.saved]));
    ({ appStatusByJob, noteFor } = await loadEmployerHistory(profile.id));
  }

  const results = jobsData
    .filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original))
    .map((job) => {
      const match = profile ? scoreJob(job, profile) : null;
      return {
        ...attachDistance(job, profile),
        match,
        scored: Boolean(match),
        saved: Boolean(savedByJobId.get(job.id)),
        application_status: appStatusByJob.get(job.id) || null,
        employer_note: noteFor(job),
      };
    });

  // Same paywall as the main /jobs endpoint: full detail only for a
  // signed-in, subscribed candidate. Anonymous visitors and signed-in
  // candidates without an active subscription both get the redacted
  // view (company identity and the real apply link withheld).
  res.json(hasFullAccess(profile) ? results : results.map(redactForNonSubscriber));
});

// GET /api/guarantee-status — powers the "We've found N of your 5
// guaranteed Excellent Matches, X days remaining" dashboard banner.
// Counts from excellent_match_log — a permanent, insert-only record of
// every job that has EVER qualified as Excellent for this candidate —
// rather than the live candidate_job_matches.excellent_match flag.
// That flag reflects only the CURRENT score and can flip if a job gets
// rescored later (job data changes, or the matching logic itself gets
// tuned), which would otherwise make a candidate's guarantee count
// silently drop over time even though they genuinely were shown 5
// Excellent Matches earlier — an unresolvable "I saw 5, you show 3"
// dispute. Only entries logged within the 30-day guarantee window
// count toward the target; the log itself keeps every entry forever
// regardless, for general record-keeping.
router.get("/guarantee-status", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("subscription_started_at, subscription_status")
    .eq("id", req.candidateId)
    .maybeSingle();

  if (!profile?.subscription_started_at) {
    return res.json({ applicable: false, reason: "No active subscription start date on file yet." });
  }

  const GUARANTEE_TARGET = 5;
  const GUARANTEE_WINDOW_DAYS = 30;
  const startedAt = new Date(profile.subscription_started_at);
  const windowEnd = new Date(startedAt.getTime() + GUARANTEE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const daysElapsed = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60 * 24);
  const daysRemaining = Math.max(0, Math.ceil(GUARANTEE_WINDOW_DAYS - daysElapsed));
  const windowOpen = daysElapsed <= GUARANTEE_WINDOW_DAYS;

  const { count } = await supabaseAdmin
    .from("excellent_match_log")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", req.candidateId)
    .lte("first_qualified_at", windowEnd.toISOString());

  const excellentCount = count || 0;

  res.json({
    applicable: true,
    excellent_count: excellentCount,
    target: GUARANTEE_TARGET,
    met: excellentCount >= GUARANTEE_TARGET,
    days_remaining: daysRemaining,
    window_open: windowOpen,
    eligible_for_refund: windowOpen === false && excellentCount < GUARANTEE_TARGET,
  });
});

// GET /api/new-matches-today-count — a real, platform-wide count of
// this candidate's active matches posted today, independent of
// whatever subset of jobs the dashboard's main list happens to have
// fetched (which is capped at a small limit for display purposes).
// Real bug this replaces: the dashboard's "New Matches Today" stat was
// counting jobs.length from that capped, best-match-sorted list —
// mathematically almost always exactly the limit value (20) regardless
// of what was actually posted today, since there are thousands of
// active jobs and the top 20 by score are shown regardless of date.
//
// Reported directly as "always low": this counted rows from
// candidate_job_matches (the precomputed table) - the exact same
// staleness problem already fixed for the main jobs list and the
// recruiter-jobs endpoint. A job posted today that hadn't yet been
// through a precompute run (increasingly likely now that the main
// candidate-facing paths no longer depend on that table at all) simply
// had no row there, so it could never be counted here even though it's
// a completely real, live job the candidate would actually see. Now
// counts directly from the jobs table itself - no precompute
// dependency, matches what "New" actually means on the New tab.
router.get("/new-matches-today-count", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Excludes foreign postings so this count stays honest — the "New"
  // tab itself doesn't filter by score (matching that here too), but a
  // job that would never actually show to this candidate at all
  // shouldn't be counted as one of their matches either.
  const { data: todaysJobs, error } = await supabaseAdmin
    .from("jobs")
    .select("location_raw, job_lng, title_original")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .gte("date_posted", todayStart.toISOString());

  if (error) return res.status(500).json({ error: error.message });
  const count = (todaysJobs || []).filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original)).length;
  res.json({ new_today: count });
});

// POST /api/jobs/:id/apply — in-site application for a recruiter-posted
// job (real ATS-sourced jobs still send candidates to source_url, same
// as before; this only applies to source_type='recruiter_posted', which
// has no external posting to apply through). Modeled on MedReps' Apply
// Now flow: a real submission housed in ROOK rather than handing the
// candidate off to compose their own email. Under the hood it still has
// to reach the recruiter by email (there's no ATS to submit into for a
// manually-posted job), but the candidate never sees that — they get a
// real in-product application experience with a real "Applied" record.
router.post("/jobs/:id/apply", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  // TEMPORARY DIAGNOSTIC LOGGING — this route has been failing with no
  // trace at all in Runtime Logs (raw DO URL, Cloudflare bypassed, no
  // console output, no crash recorded). That pattern points to a step
  // hanging on an outbound network call rather than throwing. Every
  // await below now has a log immediately before and after it, so
  // whichever pair fails to both print pinpoints exactly where this
  // sticks. Safe to remove once the real cause is confirmed and fixed.
  const tag = `[apply ${req.params.id} candidate=${req.candidateId}]`;
  console.log(`${tag} start`);
  try {
    console.log(`${tag} fetching job...`);
    const { data: job, error: jobError } = await supabaseAdmin
      .from("jobs")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    console.log(`${tag} job fetch done (error=${jobError?.message || "none"}, found=${!!job})`);
    if (jobError) return res.status(500).json({ error: jobError.message });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.source_type !== "recruiter_posted") {
      return res.status(400).json({ error: "This job isn't recruiter-posted — use its original posting link to apply." });
    }
    if (!job.recruiter_email) {
      return res.status(400).json({ error: "No recruiter contact is on file for this posting." });
    }

    const coverLetter = String(req.body?.cover_letter || "").trim();
    if (!coverLetter) return res.status(400).json({ error: "Cover letter is required." });

    console.log(`${tag} fetching candidate profile...`);
    const { data: profile } = await supabaseAdmin
      .from("candidate_profiles")
      .select("*")
      .eq("id", req.candidateId)
      .maybeSingle();
    console.log(`${tag} profile fetch done (found=${!!profile})`);

    let resumeUrl = null;
    if (profile?.resume_file_path) {
      // Wrapped in try/catch, unlike before — this was the one step in
      // the whole endpoint with no error handling at all. If it threw
      // (a malformed/unexpected stored path, for instance), the entire
      // request crashed unhandled with a raw, unhelpful message ("The
      // string did not match the expected pattern") instead of the
      // graceful degradation every other step in this route has. A
      // missing or broken résumé link shouldn't block the whole
      // application from being submitted — the recruiter still gets the
      // cover letter and a note that no résumé is attached.
      //
      // Also given an explicit timeout: this Supabase Storage call had
      // no timeout at all, unlike the email send below (which times out
      // at 20s). If Storage ever stalls instead of erroring, this used
      // to hang forever with no trace — exactly the symptom seen live.
      try {
        console.log(`${tag} signing résumé URL (path: ${profile.resume_file_path})...`);
        const signPromise = supabaseAdmin.storage
          .from("resumes")
          .createSignedUrl(profile.resume_file_path, 60 * 60 * 24 * 14); // 14-day link, same pattern as any Storage-backed download elsewhere in the app
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Résumé signed URL request timed out after 15s")), 15_000)
        );
        const { data: signed, error: signError } = await Promise.race([signPromise, timeoutPromise]);
        if (signError) throw signError;
        resumeUrl = signed?.signedUrl || null;
        console.log(`${tag} résumé URL signed successfully`);
      } catch (err) {
        console.error(`${tag} could not generate résumé link (path: ${profile.resume_file_path}): ${err.message}`);
      }
    }

    const html = `
      <p><strong>${escapeHtmlServer(profile?.name || "A ROOK candidate")}</strong> applied to your posting on ROOK: <strong>${escapeHtmlServer(job.title_original || "this role")}</strong>.</p>
      ${coverLetter.split("\n").filter(Boolean).map((p) => `<p>${escapeHtmlServer(p)}</p>`).join("")}
      ${resumeUrl ? `<p><a href="${resumeUrl}">Download résumé</a> (link active 14 days)</p>` : "<p>No résumé is on file for this candidate.</p>"}
      <p style="color:#5B6B85; font-size:13px;">Reply directly to this email to reach the candidate${profile?.email ? ` at ${escapeHtmlServer(profile.email)}` : ""}${profile?.phone ? ` or ${escapeHtmlServer(profile.phone)}` : ""}.</p>
    `;

    try {
      console.log(`${tag} sending recruiter email to ${job.recruiter_email}...`);
      await sendEmail({
        to: job.recruiter_email,
        subject: `New ROOK application: ${job.title_original || "your posting"}`,
        html,
        // Makes the "Reply directly to this email to reach the candidate"
        // line above actually true. Without this, a recruiter's reply
        // went to DIGEST_FROM_EMAIL, which has no real inbox behind it -
        // the reply would just be undeliverable or vanish silently.
        replyTo: profile?.email || undefined,
      });
      console.log(`${tag} recruiter email sent successfully`);
    } catch (err) {
      console.error(`${tag} email send failed: ${err.message}`);
      return res.status(502).json({ error: `Could not deliver the application email: ${err.message}. Nothing was recorded — try again.` });
    }

    // Record the application for the candidate's own Application History —
    // no unique constraint on (candidate_id, job_id) in the schema, so
    // check-then-write rather than upsert. Wrapped in try/catch, unlike
    // before — this was the one remaining step in the whole endpoint
    // with zero error handling. The email to the recruiter has already
    // been sent successfully by this point, so if this history-recording
    // step fails, the application itself genuinely went through — the
    // person shouldn't see a bare, unhelpful crash message here that
    // makes it look like nothing happened.
    try {
      console.log(`${tag} recording application history...`);
      const { data: existing } = await supabaseAdmin
        .from("applications")
        .select("id")
        .eq("candidate_id", req.candidateId)
        .eq("job_id", job.id)
        .maybeSingle();

      const appRow = {
        candidate_id: req.candidateId,
        job_id: job.id,
        status: "applied",
        applied_at: new Date().toISOString(),
        notes: coverLetter, // reusing the free-text notes column to keep a record of what was actually sent — no dedicated cover-letter column on this table yet
        contact_name: job.recruiter_name || null,
        contact_email: job.recruiter_email || null,
      };
      if (existing) {
        await supabaseAdmin.from("applications").update(appRow).eq("id", existing.id);
      } else {
        await supabaseAdmin.from("applications").insert(appRow);
      }
      console.log(`${tag} application history recorded`);
    } catch (err) {
      console.error(`${tag} email sent successfully, but recording history failed: ${err.message}`);
      // Still a success response — the recruiter has the real
      // application in their inbox, which is what actually matters.
    }

    console.log(`${tag} done, responding 200`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`${tag} unexpected error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong submitting your application. Please try again." });
    }
  }
});

// GET /api/jobs/:id
router.get("/jobs/:id", requireConfig, optionalAuth, async (req, res) => {
  const { data, error } = await supabaseAnon
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Job not found" });
  if (data.moderation_status && data.moderation_status !== "approved") {
    // Same protection as the listing endpoints — a pending or rejected
    // recruiter posting shouldn't be viewable even via a direct/guessed
    // link. ATS-ingested jobs always have moderation_status='approved'
    // by default, so this only ever actually blocks something for
    // recruiter-submitted rows.
    return res.status(404).json({ error: "Job not found" });
  }

  if (!req.user) {
    return res.json({
      id: data.id,
      title_original: data.title_original,
      title_normalized: data.title_normalized,
      location_raw: data.location_raw,
      compensation_text: data.compensation_text,
      salary_min: data.salary_min,
      salary_max: data.salary_max,
      date_posted: data.date_posted,
      description_preview: scrubCompanyNameFromText((data.description_text || "").slice(0, 300), data.company_name),
      gated: true,
    });
  }

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile) return res.json(data);

  // Single-job page: fall back to a live score if no precomputed row
  // exists yet, OR if the row that does exist predates the scoring
  // columns being added (candidate_fit/preference_fit/overall_score all
  // null) — this account had rows created by earlier testing before
  // that migration, so "row exists" alone isn't enough to trust it; it
  // has to actually contain a real score. `row.scored_at` is only ever
  // set by scoreAndStoreForCandidate(), so its presence is what
  // distinguishes a genuinely fresh row from an old, empty one.
  const { data: row } = await supabaseAdmin
    .from("candidate_job_matches")
    .select("*")
    .eq("candidate_id", profile.id)
    .eq("job_id", data.id)
    .maybeSingle();

  const hasRealScore = row && row.scored_at != null;
  const match = hasRealScore ? matchFromRow(row) : scoreJob(data, profile);

  // Persist a freshly-computed live fallback score so list views
  // (dashboard, recruiter-jobs) pick it up on their next load instead
  // of staying stuck showing this job as unscored until the next
  // scheduled precompute run. Reported bug: View Analysis showed a real
  // 77% score for a job that still showed "—" / "Just added" on both
  // list pages, because this fallback used to be display-only.
  if (!hasRealScore) {
    supabaseAdmin
      .from("candidate_job_matches")
      .upsert(
        {
          candidate_id: profile.id,
          job_id: data.id,
          overall_score: match.overall_score,
          candidate_fit: match.candidate_fit,
          preference_fit: match.preference_fit,
          recommendation: match.recommendation,
          reasons: match.reasons,
          concerns: match.concerns,
          confidence: match.confidence,
          hard_disqualifier: match.hard_disqualifier,
          categories: match.categories,
          excellent_match: match.excellent_match,
          scored_at: new Date().toISOString(),
        },
        { onConflict: "candidate_id,job_id" }
      )
      .then(({ error }) => {
        if (error) console.error(`Failed to persist live fallback score for job ${data.id}: ${error.message}`);
      });
  }

  const result = { ...data, match, saved: Boolean(row?.saved) };
  res.json(hasFullAccess(profile) ? result : redactForNonSubscriber(result));
});

// POST /api/jobs/:id/save — toggle whether this job is saved. Body: { saved: true|false }.
router.post("/jobs/:id/save", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const saved = req.body.saved !== false;
  const { data, error } = await supabaseAdmin
    .from("candidate_job_matches")
    .upsert(
      { candidate_id: req.candidateId, job_id: req.params.id, saved },
      { onConflict: "candidate_id,job_id" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/jobs/:id/dismiss — mark a job as not interested; it stops
// appearing in GET /api/jobs for this candidate from then on.
router.post("/jobs/:id/dismiss", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const dismissed = req.body.dismissed !== false;
  const { data, error } = await supabaseAdmin
    .from("candidate_job_matches")
    .upsert(
      { candidate_id: req.candidateId, job_id: req.params.id, dismissed },
      { onConflict: "candidate_id,job_id" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/saved-jobs — full job details for everything the caller has
// saved, with precomputed scores (same source as the main listing).
router.get("/saved-jobs", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const { data: rows, error } = await supabaseAdmin
    .from("candidate_job_matches")
    .select(`*, jobs(${JOB_LIST_COLUMNS})`)
    .eq("candidate_id", req.candidateId)
    .eq("saved", true);

  if (error) return res.status(500).json({ error: error.message });

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("subscription_status, home_lat, home_lng, trial_ends_at, subscription_cancel_at")
    .eq("id", req.candidateId)
    .maybeSingle();

  const jobs = (rows || [])
    .filter((row) => row.jobs) // guards against a job having been removed since it was saved
    .filter((row) => !mentionsNonUsCountry(row.jobs.location_raw, row.jobs.job_lng, row.jobs.title_original))
    .map((row) => ({
      ...attachDistance(row.jobs, profile),
      match: row.overall_score != null ? matchFromRow(row) : null,
      saved: true,
    }));

  res.json(hasFullAccess(profile) ? jobs : jobs.map(redactForNonSubscriber));
});

// Attached to the router itself (not a separate export shape) so
// server.js's existing `require("./backend/routes/jobs")` still works
// unchanged as Express middleware, while dailyDigest.js can pull these
// specific functions off the same module — one gating implementation
// reused everywhere a non-subscribed candidate's view needs masking,
// not a second copy that could drift from it. The entitlement check
// itself (hasFullAccess) now lives in matching.js instead — dailyDigest.js
// imports that directly.
router.scrubCompanyNameFromText = scrubCompanyNameFromText;
router.redactForNonSubscriber = redactForNonSubscriber;

// GET /api/onboarding/job-preview
// Returns up to 3 masked job listings and a total count filtered by
// industry and state. Used on screen 3c to show real jobs exist before
// the user creates an account. No auth required. No match scores.
// Server-side field masking — employer identity and apply links never sent.
const JP_PREVIEW_RATE = new Map();
function checkJobPreviewRate(ip) {
  const now = Date.now();
  const e = JP_PREVIEW_RATE.get(ip);
  if (!e || now > e.resetAt) { JP_PREVIEW_RATE.set(ip, { count: 1, resetAt: now + 30_000 }); return true; }
  if (e.count >= 10) return false;
  e.count++;
  return true;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of JP_PREVIEW_RATE) if (n > v.resetAt) JP_PREVIEW_RATE.delete(k); }, 300_000);

router.get('/onboarding/job-preview', async (req, res) => {
  if (!isConfigured) {
    console.log('[job-preview] not configured');
    return res.json({ jobs: [], total_count: 0 });
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!checkJobPreviewRate(ip)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const { data: jobs, error } = await supabaseAnon.from('jobs')
      .select('title_original, city, state, remote_status, compensation_text, company_name')
      .eq('status', 'active')
      .eq('moderation_status', 'approved')
      .order('date_posted', { ascending: false })
      .limit(8);

    if (error) {
      console.error('[job-preview] DB error:', error.message);
      return res.json({ jobs: [], total_count: 0 });
    }

    console.log('[job-preview] rows returned:', jobs?.length, 'first:', jobs?.[0]?.title_original);

    const masked = (jobs || []).slice(0, 5).map(j => ({
      title_original: j.company_name
        ? (scrubCompanyNameFromText(j.title_original, j.company_name) || j.title_original)
        : j.title_original,
      city: j.city,
      state: j.state,
      remote_status: j.remote_status,
      compensation_text: j.compensation_text,
    }));

    res.json({ jobs: masked, total_count: jobs?.length || 0 });
  } catch (err) {
    console.error('[job-preview] exception:', err.message);
    res.json({ jobs: [], total_count: 0 });
  }
});


// GET /api/onboarding/warm-jobs
// Triggers fetchActiveJobs() server-side to warm the 2-minute active-jobs
// cache. Called fire-and-forget from doBackendWork concurrently with the
// résumé upload, so the cache is hot when the preview request fires.
//
// No authentication required — this endpoint performs no scoring and
// returns no job data. It only fills a server-side in-memory cache.
// Rate-limited at 5 req/30 s per IP to prevent sustained abuse.
const WARM_RATE = new Map();
function checkWarmRateLimit(ip) {
  const now = Date.now();
  const e = WARM_RATE.get(ip);
  if (!e || now > e.resetAt) { WARM_RATE.set(ip, { count: 1, resetAt: now + 30_000 }); return true; }
  if (e.count >= 5) return false;
  e.count++;
  return true;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of WARM_RATE) if (n > v.resetAt) WARM_RATE.delete(k); }, 300_000);

router.get("/onboarding/warm-jobs", async (req, res) => {
  if (!isConfigured) return res.json({ ok: false, reason: "not_configured" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!checkWarmRateLimit(ip)) return res.status(429).json({ ok: false, reason: "rate_limited" });
  // Fire and don't block the response — the client doesn't need to wait
  fetchActiveJobs(supabaseAdmin).catch(err => console.error("[warm-jobs]", err.message));
  res.json({ ok: true });
});

// GET /api/onboarding/match-preview
// Returns a safe count and top scores for the locked-results screen
// shown at the end of onboarding, before the candidate starts their trial.
//
// Security:
//   - Requires authentication (requireAuth).
//   - Reads profile from the database — does NOT trust query parameters
//     for industry, experience, territory, or any other scoring input.
//   - Returns only: { count, top_matches[], scoring_status }
//   - Never returns job IDs, titles, employer names, descriptions, or URLs.
//
// Performance:
//   - scoreJob() is pure in-memory Haversine + JSON math — no external
//     API calls (confirmed: distanceMiles is a pure Haversine function;
//     scoreJob() has no AI/embedding calls of its own).
//   - fetchActiveJobs() issues ~17 sequential Supabase queries (150 jobs/page
//     × 17 pages for ~2,500 active jobs). Estimated DB-fetch time: 1–3 s.
//   - scoreJob() on ~2,500 jobs: <50 ms (6,000 calls in ~240 ms per the
//     benchmark comment in jobs.js; 2,500 is less than half that).
//   - Total endpoint budget: ~1.5–3.5 s (dominated by DB fetch).
//   - fetchActiveJobs() on repeated calls returns the SAME rows; there is
//     no caching inside it. The cache below prevents redundant fetches.
//
// Protection against repeated calls:
//   - previewCache: per-user result cache with 5-minute TTL. Handles
//     double-clicks, page refreshes, multiple tabs, and browser retries.
//   - previewInFlight: per-user in-flight deduplication. If two requests
//     arrive for the same user simultaneously, the second waits for the
//     first's Promise to resolve rather than starting a parallel scoring run.
//
// Count meaning:
//   - All active+approved jobs that scoreJob() assigns a non-null score > 0,
//     after filtering out non-US postings. No minimum score floor is applied —
//     the unlocked dashboard has none either (same eligible-job population).
//   - Wording: "We ranked N current medical sales opportunities for you."
//     Not "N match your preferences" — all ranked, not all perfect matches.
//
// Display badge logic:
//   - Mirrors rook-dashboard.html's card renderer exactly:
//       excellent_match === true  → "Excellent Match"
//       otherwise                 → engine recommendation string directly
//   - Engine recommendations: "Strong Match" (≥90%), "Apply" (≥80%),
//     "Stretch Apply" (≥70%), "Skip" (<70%).
//   - The 75% threshold in the dashboard's STAT CARDS and tab filters is a
//     count grouping only — it is NOT applied to individual card labels here
//     or in the unlocked dashboard card renderer. Using it as a card label
//     would create a discrepancy where the same score shows different labels
//     in locked vs. unlocked views.
const PREVIEW_CACHE_TTL_MS  = 5 * 60 * 1000; // 5 minutes
const previewCache    = new Map(); // userId → { result, expiresAt }
const previewInFlight = new Map(); // userId → Promise

// Extract a displayable location string from a job, with multiple fallbacks.
// Used in match-preview where location_raw can be null even when coordinates exist.
function jobLocationDisplay(job) {
  const city  = job?.city  || '';
  const state = job?.state || '';
  const raw   = job?.location_raw || '';
  const title = job?.title_original || '';

  if (city && state) return `${city}, ${state}`;
  if (city)  return city;
  if (state) return state;

  if (raw) {
    if (/^remote$/i.test(raw.trim())) return 'Remote';
    // "City, ST" or "City, State" already clean
    const commaMatch = raw.match(/^([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2}|[A-Za-z]+)(?:,.*)?$/);
    if (commaMatch) return `${commaMatch[1].trim()}, ${commaMatch[2].trim()}`;
    // "United States-State-City" or "USA-FL-City"
    const dashMatch = raw.match(/(?:United States?|USA?)-([A-Za-z]+(?:\s+[A-Za-z]+)*)-([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
    if (dashMatch) return `${dashMatch[2].trim()}, ${dashMatch[1].trim()}`;
    // Single state name or abbreviation
    if (/^[A-Za-z ]{2,30}$/.test(raw.trim())) return raw.trim();
  }

  // Last resort: extract "City, ST" or "City, State" from job title
  const titleLoc = title.match(/[–-]\s*([A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2})/);
  if (titleLoc) return titleLoc[1].trim();
  // State name in title
  const titleState = title.match(/(North |South |East |West )?(?:Florida|Texas|California|New York|Ohio|Georgia|Illinois|Virginia|North Carolina|South Carolina|Pennsylvania|Michigan|Tennessee|Washington|Massachusetts|Colorado|Arizona|Minnesota|Indiana|Missouri|Wisconsin|Maryland|Connecticut|Nevada|Louisiana|Alabama|Kentucky|Oregon|Oklahoma|New Mexico|Utah|Iowa|Arkansas|Kansas|Nebraska|Mississippi)/i);
  if (titleState) return titleState[0].trim();

  return '';
}

// POST /api/onboarding/anonymous-preview
// No auth required. Takes location + preferences in body, returns top 3
// scored jobs with titles/locations/scores — never company names or apply links.
// Rate-limited by IP to prevent abuse.
const _anonPreviewCalls = new Map(); // ip → {count, resetAt}
router.post("/onboarding/anonymous-preview", requireConfig, async (req, res) => {
  // Rate limit: 20 calls per IP per minute
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
  const now = Date.now();
  const entry = _anonPreviewCalls.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  _anonPreviewCalls.set(ip, entry);
  if (entry.count > 20) return res.status(429).json({ error: "Too many requests" });

  const { lat, lng, state, industry, years, territories } = req.body || {};
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  try {
    const profile = {
      home_lat: Number(lat),
      home_lng: Number(lng),
      home_state: state || null,
      desired_industries: industry ? [industry] : [],
      total_sales_years: Number(years) || 0,
      territory_size_preferences: territories || ["local", "regional"],
      territory_size_preference: (territories || ["local"])[0],
    };

    // ── Exact same SQL + scoring as dashboard live path ──────────────────
    const latDelta = 300 / 69;
    const lngDelta = 300 / (69 * Math.max(0.1, Math.cos((profile.home_lat * Math.PI) / 180)));

    const { data: jobs, error } = await supabaseAdmin
      .from("jobs")
      .select(JOB_LIST_COLUMNS_NO_DESCRIPTION)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .or(`job_lat.is.null,remote_status.eq.remote,and(job_lat.gte.${profile.home_lat - latDelta},job_lat.lte.${profile.home_lat + latDelta},job_lng.gte.${profile.home_lng - lngDelta},job_lng.lte.${profile.home_lng + lngDelta})`)
      .limit(400);

    if (error) throw new Error(error.message);

    // Word-for-word copy of dashboard titleLocSanityPass
    const TITLE_LOC_CHECKS = {
      'south florida': { lat: 25.9, lng: -80.3 },
      'miami':         { lat: 25.77, lng: -80.19 },
      'fort lauderdale': { lat: 26.12, lng: -80.14 },
      'palm beach':    { lat: 26.71, lng: -80.05 },
      'pensacola':     { lat: 30.42, lng: -87.22 },
      'tallahassee':   { lat: 30.44, lng: -84.28 },
      'jacksonville':  { lat: 30.33, lng: -81.66 },
    };
    function titleLocSanityPass(job) {
      if (!job.job_lat || !profile?.home_lat) return true;
      const title = (job.title_original || '').toLowerCase();
      const computedDist = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
      for (const [kw, coords] of Object.entries(TITLE_LOC_CHECKS)) {
        if (title.includes(kw)) {
          const actual = distanceMiles(profile.home_lat, profile.home_lng, coords.lat, coords.lng);
          if (Math.abs(actual - computedDist) > 80) return false;
        }
      }
      return true;
    }

    // Word-for-word copy of dashboard scoring + sort
    const scored = (jobs || [])
      .filter(j => !mentionsNonUsCountry(j.location_raw, j.job_lng, j.title_original))
      .filter(j => titleLocSanityPass(j))
      .map(j => {
        const distMi = j.job_lat != null
          ? Math.round(distanceMiles(profile.home_lat, profile.home_lng, j.job_lat, j.job_lng))
          : null;
        return { job: j, score: scoreJob(j, profile), distMi };
      })
      .filter(r => r.score.overall_score >= 50)
      .sort((a, b) => b.score.overall_score - a.score.overall_score)
      .slice(0, 3);

    const top3 = scored.map(({ job, score, distMi }) => {
      return {
        overall_score: Math.round(score.overall_score),
        title: job.title_original || job.title_normalized || "Medical Sales Role",
        location_display: jobLocationDisplay(job),
        distance_miles: distMi,
        reasons: (score.reasons || []).filter(r => !/miles? from you/i.test(r)).slice(0, 1),
      };
    });

    return res.json({ count: top3.length, top_matches: top3 });
  } catch (err) {
    console.error("[anonymous-preview]", err.message);
    return res.status(500).json({ error: "Preview unavailable" });
  }
});

router.get("/onboarding/match-preview", requireConfig, requireAuth, async (req, res) => {
  const userId = req.user.id;

  // ── 1. Cache hit ────────────────────────────────────────────────────
  const cached = previewCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ...cached.result, from_cache: true });
  }

  // ── 2. In-flight deduplication ──────────────────────────────────────
  // If a scoring run for this user is already in progress (e.g., two tabs
  // submitted at the same moment), wait for the existing Promise instead
  // of starting a parallel one.
  if (previewInFlight.has(userId)) {
    try {
      const result = await previewInFlight.get(userId);
      return res.json({ ...result, from_cache: true });
    } catch {
      return res.status(500).json({ error: "Could not calculate your matches right now. Please try again.", scoring_complete: false });
    }
  }

  // ── 3. Load profile ─────────────────────────────────────────────────
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileError) return res.status(500).json({ error: profileError.message });
  if (!profile) return res.status(404).json({ error: "Profile not found. Complete onboarding first." });

  // ── 4. Live scoring (awaited, not fire-and-forget) ──────────────────
  const scoringPromise = (async () => {
    const t0 = Date.now();

    // ── Fast path: use pre-computed scores from candidate_job_matches ──
    // scoreAndStoreForCandidate (called during v3 onboarding background
    // processing) writes scores here. Reading them is a single indexed
    // DB query instead of 17+ sequential pages + in-memory scoring.
    if (profile.id) {
      const { data: precomputed, error: pcErr } = await supabaseAdmin
        .from('candidate_job_matches')
        .select(`
          overall_score, excellent_match, recommendation, reasons,
          jobs!inner(id, title_normalized, title_original, city, state, location_raw, company_name)
        `)
        .eq('candidate_id', profile.id)
        .gt('overall_score', 0)
        .order('overall_score', { ascending: false })
        .limit(3);

      if (pcErr) {
        console.error(`[match-preview] uid=${userId.slice(0,8)} precomputed join error: ${pcErr.message}`);
      }

      // If no pre-computed scores yet, scoring may still be writing.
      // Retry for up to 20 seconds (10 × 2s) before falling back to
      // in-memory scoring — BUT only if the user has a résumé, since
      // without one there's no background scoring job and we'd just
      // waste 20 seconds waiting for scores that will never arrive.
      const hasResume = profile.resume_url || profile.resume_uploaded_at;
      if (!pcErr && !precomputed?.length && hasResume) {
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          const { data: retry, error: retryErr } = await supabaseAdmin
            .from('candidate_job_matches')
            .select('overall_score, excellent_match, recommendation, reasons, jobs!inner(id, title_normalized, title_original, city, state, location_raw, company_name)')
            .eq('candidate_id', profile.id)
            .gt('overall_score', 0)
            .order('overall_score', { ascending: false })
            .limit(3);
          if (!retryErr && retry?.length >= 1) {
            console.log(`[match-preview] uid=${userId.slice(0,8)} precomputed scores ready after ${(attempt+1)*2}s wait`);
            const { count } = await supabaseAdmin.from('candidate_job_matches').select('id', { count: 'exact', head: true }).eq('candidate_id', profile.id).gt('overall_score', 0);
            return { count: count || retry.length, top_matches: retry.map(row => {
              const job = row.jobs;
              const rawTitle = job?.title_normalized || job?.title_original || null;
              const safeTitle = (rawTitle && job?.company_name) ? (scrubCompanyNameFromText(rawTitle, job.company_name) || rawTitle) : rawTitle;
              return { overall_score: Math.round(row.overall_score), excellent_match: Boolean(row.excellent_match), recommendation: row.recommendation || null, title: safeTitle, location_display: jobLocationDisplay(job), reasons: (row.reasons || []).slice(0, 2) };
            }), scoring_complete: true, from_precomputed: true };
          }
          if (retryErr) break; // join failing — go to in-memory
        }
      }

      if (!pcErr && precomputed?.length >= 1) {
        const { count } = await supabaseAdmin
          .from('candidate_job_matches')
          .select('id', { count: 'exact', head: true })
          .eq('candidate_id', profile.id)
          .gt('overall_score', 0);

        console.log(`[match-preview] uid=${userId.slice(0,8)} using precomputed scores ms=${Date.now()-t0} top=${precomputed[0]?.overall_score}`);

        const topThree = precomputed.map(row => {
          const job = row.jobs;
          const rawTitle = job?.title_normalized || job?.title_original || null;
          const safeTitle = (rawTitle && job?.company_name)
            ? (scrubCompanyNameFromText(rawTitle, job.company_name) || rawTitle)
            : rawTitle;
          return {
            overall_score:   Math.round(row.overall_score),
            excellent_match: Boolean(row.excellent_match),
            recommendation:  row.recommendation || null,
            title:   safeTitle,
            location_display: jobLocationDisplay(job),
            reasons: (row.reasons || []).slice(0, 2),
          };
        });

        return { count: count || precomputed.length, top_matches: topThree, scoring_complete: true, from_precomputed: true };
      }
    }

    // ── Slow path: in-memory scoring (no pre-computed scores yet) ──
    // Use a direct SQL bounding box query instead of fetchActiveJobs (which
    // loads ALL 5,000+ jobs into memory). This cuts the fetch to ~300-400
    // jobs and works even on a cold server with no warm cache.
    const SCORE_COLS = "id, title_original, title_normalized, company_name, location_raw, job_lat, job_lng, city, state, industry, remote_status, employment_type, travel_percentage, salary_min, salary_max, compensation_text, ai_analysis, date_posted, last_seen_at";

    let jobQuery = supabaseAdmin
      .from("jobs")
      .select(SCORE_COLS)
      .eq("status", "active")
      .eq("moderation_status", "approved");

    if (profile.home_lat != null && profile.home_lng != null) {
      const latDelta = 300 / 69;
      const lngDelta = 300 / (69 * Math.max(0.1, Math.cos((profile.home_lat * Math.PI) / 180)));
      // Null-coordinate jobs: include only if remote or in user's home state
      // so a Texas user never sees Ohio jobs in their preview
      const homeStateAbbr = stateAbbrFromName(profile.home_state);
      const nullCoordFilter = homeStateAbbr
        ? `and(job_lat.is.null,state.eq.${homeStateAbbr})`
        : `job_lat.is.null`;
      jobQuery = jobQuery.or(
        `remote_status.eq.remote,${nullCoordFilter},and(job_lat.gte.${profile.home_lat - latDelta},job_lat.lte.${profile.home_lat + latDelta},job_lng.gte.${profile.home_lng - lngDelta},job_lng.lte.${profile.home_lng + lngDelta})`
      );
    }

    const { data: activeJobs, error: jobFetchErr } = await jobQuery.limit(500);
    if (jobFetchErr) throw new Error(`match-preview job fetch failed: ${jobFetchErr.message}`);
    const tFetch = Date.now();

    // Diagnostic: log which scoring inputs are present for this user.
    // candidate_fit = null when resume_structured is absent, reducing
    // overall_score to preference_fit only, which can be ~9% when
    // distance multiplier is large and no home location is set.
    console.log(`[match-preview] uid=${userId.slice(0,8)} ` +
      `resume_structured=${!!profile.resume_structured} ` +
      `candidate_embedding=${!!profile.candidate_embedding} ` +
      `home_lat=${profile.home_lat != null} home_state=${profile.home_state || 'null'} ` +
      `industries=${JSON.stringify(profile.desired_industries || [])} ` +
      `fetch_ms=${tFetch - t0}`);

    const scored = activeJobs
      .filter((job) => !mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original))
      .map((job) => ({ score: scoreJob(job, profile), jobId: job.id, job }))
      .filter((r) => r.score.overall_score != null && r.score.overall_score > 0)
      .sort((a, b) => b.score.overall_score - a.score.overall_score);

    const tScore = Date.now();
    console.log(`[match-preview] uid=${userId.slice(0,8)} score_ms=${tScore - tFetch} count=${scored.length} top=${scored[0]?.score?.overall_score ?? 'none'}`);

    const count = scored.length;

    // Top 3: preview-safe fields only. Employer identity, apply links,
    // descriptions, and recruiter info are never included.
    // Company names are scrubbed from titles using the existing helper.
    const topThree = scored.slice(0, 3).map((r) => {
      const job = r.job;
      const rawTitle = job.title_normalized || job.title_original || null;
      const safeTitle = (rawTitle && job.company_name)
        ? (scrubCompanyNameFromText(rawTitle, job.company_name) || rawTitle)
        : rawTitle;
      return {
        overall_score:   Math.round(r.score.overall_score),
        excellent_match: Boolean(r.score.excellent_match),
        recommendation:  r.score.recommendation || null,
        // Preview-safe job detail
        title:        safeTitle,
        location_display: jobLocationDisplay(job),
        reasons: (r.score.reasons || []).slice(0, 2),
      };
    });

    return { count, top_matches: topThree, scoring_complete: true };
  })();

  previewInFlight.set(userId, scoringPromise);

  try {
    const result = await scoringPromise;

    // Kick off a full background score+store immediately after the slow-path
    // live scoring completes. By the time the user finishes the trial setup
    previewCache.set(userId, { result, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
    res.json(result);
  } catch (err) {
    console.error(`[onboarding/match-preview] scoring failed for user ${userId}: ${err.message}`);
    res.status(500).json({
      error: "Could not calculate your matches right now. Please try again.",
      scoring_complete: false,
    });
  } finally {
    previewInFlight.delete(userId);
  }
});

module.exports = router;
