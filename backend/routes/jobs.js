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
const { scoreJob } = require("../matching");
const { scoreAndStoreForCandidate } = require("../scoring/precompute");
const { distanceMiles } = require("../geocoding");
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

// The actual paywall: a signed-in candidate without an active
// subscription still sees their REAL match score, reasons, and every
// other job detail — that's what makes the paywall worth paying past,
// unlike the anonymous teaser, which hides that too. Only the employer's
// identity and the real way to apply are withheld, the same two fields
// gated from anonymous visitors. subscription_status is written by the
// Stripe webhook (backend/routes/stripe.js) — anything other than the
// literal string 'active' (null, 'cancelled', undefined) is treated as
// not subscribed, so a candidate is gated by default unless payment has
// genuinely gone through.
function isSubscribed(profile) {
  return profile?.subscription_status === "active";
}

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
  const words = companyName.split(/\s+/).filter((w) => w.replace(/[^a-zA-Z]/g, "").length > 3 && !COMPANY_SUFFIX_WORDS.has(w.toLowerCase()));
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
    ...rest
  } = job;
  const scrubbedFullText = scrubCompanyNameFromText(description_text, company_name);
  return {
    ...rest,
    description_text: scrubbedFullText,
    description_preview: scrubCompanyNameFromText(description_preview, company_name) ?? (scrubbedFullText ? scrubbedFullText.slice(0, 300) : undefined),
    subscription_required: true,
  };
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

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, optionalAuth, async (req, res) => {
  const { industry, state, limit = 20 } = req.query;

  // Anonymous browsing — teaser only, unchanged from before: company
  // name and any way to actually apply stay withheld; everything about
  // the role itself stays visible. No scoring concept applies here, so
  // this still queries jobs directly by recency, not through
  // candidate_job_matches.
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

    let query = supabaseAnon
      .from("jobs")
      // Trimmed to only what this page actually renders or needs for
      // sorting — was previously select("*"), which pulled every
      // column including full ai_analysis JSON and job_embedding
      // vectors for up to 200 rows on every single anonymous page
      // load. Those are large and completely unused here.
      .select("id, title_original, title_normalized, location_raw, compensation_text, salary_min, salary_max, date_posted, description_text, company_name, job_lat, job_lng, remote_status")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .order("date_posted", { ascending: false })
      .limit(Math.max(Number(limit), 200)); // pull enough candidates to sort by distance below, not just the final display count
    if (industry) query = query.eq("industry", industry);
    if (state) query = query.eq("state", state);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Sort by the anonymous visitor's real approximate location, not
    // raw recency. Reported real problem: an anonymous visitor in
    // Florida was seeing jobs in Australia and Texas at the top of the
    // page meant to convince them to sign up — nothing was using
    // location at all for this page. There's no candidate profile yet
    // (they haven't signed up), so this uses IP-based geolocation
    // (ipwho.is, free, no API key, no permission prompt needed unlike
    // the browser Geolocation API) as a reasonable approximation of
    // where the visitor actually is.
    //
    // Wrapped with a hard 1.5s timeout — this is a best-effort nicety,
    // not something worth ever blocking the page on. Without a
    // timeout, a slow or unreachable external geolocation service could
    // stall this entire response indefinitely; a plain try/catch alone
    // doesn't protect against a hang, only against an outright error.
    let visitorCoords = null;
    try {
      const forwardedFor = req.headers["x-forwarded-for"];
      const ip = (forwardedFor ? forwardedFor.split(",")[0].trim() : null) || req.socket.remoteAddress;
      if (ip && ip !== "::1" && ip !== "127.0.0.1") {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        try {
          const geoRes = await fetch(`https://ipwho.is/${ip}`, { signal: controller.signal });
          const geo = await geoRes.json();
          if (geo?.success && geo.latitude != null && geo.longitude != null) {
            visitorCoords = { lat: geo.latitude, lng: geo.longitude };
          }
        } finally {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      console.error(`IP geolocation failed or timed out for anonymous browse request: ${err.message}`);
    }

    let sorted = data;
    if (visitorCoords) {
      sorted = [...data].sort((a, b) => {
        const distA = (a.job_lat != null && a.job_lng != null) ? distanceMiles(visitorCoords.lat, visitorCoords.lng, a.job_lat, a.job_lng) : null;
        const distB = (b.job_lat != null && b.job_lng != null) ? distanceMiles(visitorCoords.lat, visitorCoords.lng, b.job_lat, b.job_lng) : null;
        if (distA == null && distB == null) return 0;
        if (distA == null) return 1;
        if (distB == null) return -1;
        return distA - distB;
      });
    }
    sorted = sorted.slice(0, Number(limit));

    const teaser = sorted.map((job) => ({
      id: job.id,
      title_original: job.title_original,
      title_normalized: job.title_normalized,
      location_raw: job.location_raw,
      compensation_text: job.compensation_text,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      date_posted: job.date_posted,
      // Scrubbed against the real company_name BEFORE that field gets
      // left off this teaser object — same bug fix as
      // redactForNonSubscriber above, applies here too since this is a
      // separate code path (anonymous browsing has no candidate profile
      // to check a subscription against, so it never reaches that
      // function at all).
      description_preview: scrubCompanyNameFromText((job.description_text || "").slice(0, 160), job.company_name),
      gated: true,
    }));
    return res.json({ jobs: teaser, total_count: totalCount || 0, sorted_by_location: Boolean(visitorCoords) });
  }

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile) {
    // No profile yet at all (onboarding not completed) — nothing to
    // score against. Same as before: fall back to the plain job list.
    let query = supabaseAnon.from("jobs").select("*").eq("status", "active").eq("moderation_status", "approved").order("date_posted", { ascending: false }).limit(Number(limit));
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
  const nearLat = req.query.near_lat != null ? Number(req.query.near_lat) : null;
  const nearLng = req.query.near_lng != null ? Number(req.query.near_lng) : null;
  if (nearLat != null && nearLng != null && !Number.isNaN(nearLat) && !Number.isNaN(nearLng)) {
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
      .select("*")
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

    // Scores against a location-shifted COPY of the real profile — every
    // other preference (industry, comp, experience, exclusions) stays
    // the candidate's own real, actual profile; only the point distance
    // is measured from shifts to the explored location, which is the
    // entire point of "what if I lived here instead."
    const exploredProfile = { ...profile, home_lat: nearLat, home_lng: nearLng };
    let scored = nearby
      .map((job) => ({ ...job, match: scoreJob(job, exploredProfile) }))
      .filter((job) => industry ? job.industry === industry : true)
      .filter((job) => state ? job.state === state : true)
      .sort((a, b) => (b.match?.overall_score ?? -1) - (a.match?.overall_score ?? -1))
      .slice(0, Number(limit));

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
      jobs: isSubscribed(profile) ? results : results.map(redactForNonSubscriber),
      scoring_in_progress: false,
      explored_location: true,
    });
  }

  async function fetchScoredRows() {
    let query = supabaseAdmin
      .from("candidate_job_matches")
      .select("*, jobs!inner(*)")
      .eq("candidate_id", profile.id)
      .eq("dismissed", false)
      .eq("jobs.status", "active")
      .eq("jobs.moderation_status", "approved")
      .order("overall_score", { ascending: false, nullsFirst: false })
      .limit(Number(limit));
    if (industry) query = query.eq("jobs.industry", industry);
    if (state) query = query.eq("jobs.state", state);
    return query;
  }

  let { data: rows, error } = await fetchScoredRows();
  if (error) return res.status(500).json({ error: error.message });

  // Non-blocking fallback for a brand-new candidate whose scores haven't
  // been computed yet. This USED to run scoreAndStoreForCandidate
  // synchronously, inline, inside this request — meaning a new
  // candidate's very first dashboard load was waiting on the exact same
  // full scoring pass (now ~2,500 jobs and growing) that was just
  // timing out even in a 30-minute background script with no time
  // pressure at all. A live web request has nowhere near that much
  // tolerance — a slow first load risked showing a brand-new paying
  // candidate a broken dashboard on their very first visit.
  //
  // Now: kick off scoring in the background (don't await it) and return
  // immediately with scoring_in_progress: true so the frontend can show
  // a "Building your matches" state and poll GET /scoring-status instead
  // of blocking the page load on it. This only ever fires once per
  // candidate — once rows exist, every future request hits the fast
  // path above and this block never runs again.
  let scoringInProgress = false;
  if ((!rows || rows.length === 0)) {
    const { count } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("id", { count: "exact", head: true })
      .eq("candidate_id", profile.id);
    if (!count || count === 0) {
      scoringInProgress = true;
      scoreAndStoreForCandidate(supabaseAdmin, profile).catch((err) => {
        console.error(`Background first-time scoring failed for candidate ${profile.id}: ${err.message}`);
      });
    }
  }

  const { appStatusByJob, noteFor } = await loadEmployerHistory(profile.id);

  const results = (rows || []).map((row) => ({
    ...attachDistance(row.jobs, profile),
    match: matchFromRow(row),
    saved: Boolean(row.saved),
    application_status: appStatusByJob.get(row.job_id) || null,
    employer_note: noteFor(row.jobs),
  }));

  res.json({
    jobs: isSubscribed(profile) ? results : results.map(redactForNonSubscriber),
    scoring_in_progress: scoringInProgress,
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

  let scoresByJobId = new Map();
  let appStatusByJob = new Map();
  let noteFor = () => null;
  if (profile) {
    const { data: matchRows } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("*")
      .eq("candidate_id", profile.id)
      .eq("dismissed", false)
      .in("job_id", jobsData.map((j) => j.id));
    scoresByJobId = new Map((matchRows || []).map((r) => [r.job_id, r]));
    ({ appStatusByJob, noteFor } = await loadEmployerHistory(profile.id));
  }

  const results = jobsData.map((job) => {
    const matchRow = scoresByJobId.get(job.id);
    return {
      ...attachDistance(job, profile),
      match: matchRow ? matchFromRow(matchRow) : null,
      scored: Boolean(matchRow),
      saved: Boolean(matchRow?.saved),
      application_status: appStatusByJob.get(job.id) || null,
      employer_note: noteFor(job),
    };
  });

  // Same paywall as the main /jobs endpoint: full detail only for a
  // signed-in, subscribed candidate. Anonymous visitors and signed-in
  // candidates without an active subscription both get the redacted
  // view (company identity and the real apply link withheld).
  res.json(isSubscribed(profile) ? results : results.map(redactForNonSubscriber));
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
router.get("/new-matches-today-count", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count, error } = await supabaseAdmin
    .from("candidate_job_matches")
    .select("id, jobs!inner(date_posted, status)", { count: "exact", head: true })
    .eq("candidate_id", req.candidateId)
    .eq("jobs.status", "active")
    .gte("jobs.date_posted", todayStart.toISOString());

  if (error) return res.status(500).json({ error: error.message });
  res.json({ new_today: count || 0 });
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
  res.json(isSubscribed(profile) ? result : redactForNonSubscriber(result));
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
    .select("*, jobs(*)")
    .eq("candidate_id", req.candidateId)
    .eq("saved", true);

  if (error) return res.status(500).json({ error: error.message });

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("subscription_status")
    .eq("id", req.candidateId)
    .maybeSingle();

  const jobs = (rows || [])
    .filter((row) => row.jobs) // guards against a job having been removed since it was saved
    .map((row) => ({
      ...row.jobs,
      match: row.overall_score != null ? matchFromRow(row) : null,
      saved: true,
    }));

  res.json(isSubscribed(profile) ? jobs : jobs.map(redactForNonSubscriber));
});

module.exports = router;
