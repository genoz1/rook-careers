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

function redactForNonSubscriber(job) {
  const {
    company_name, source_url, application_url,
    recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, // same gate applies to recruiter postings
    ...rest
  } = job;
  return { ...rest, subscription_required: true };
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

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, optionalAuth, async (req, res) => {
  const { industry, state, limit = 20 } = req.query;

  // Anonymous browsing — teaser only, unchanged from before: company
  // name and any way to actually apply stay withheld; everything about
  // the role itself stays visible. No scoring concept applies here, so
  // this still queries jobs directly by recency, not through
  // candidate_job_matches.
  if (!req.user) {
    let query = supabaseAnon
      .from("jobs")
      .select("*")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .order("date_posted", { ascending: false })
      .limit(Number(limit));
    if (industry) query = query.eq("industry", industry);
    if (state) query = query.eq("state", state);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const teaser = data.map((job) => ({
      id: job.id,
      title_original: job.title_original,
      title_normalized: job.title_normalized,
      location_raw: job.location_raw,
      compensation_text: job.compensation_text,
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      date_posted: job.date_posted,
      description_preview: (job.description_text || "").slice(0, 160),
      gated: true,
    }));
    return res.json(teaser);
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

  // Fallback for a brand-new candidate whose scores haven't been
  // computed yet — the fire-and-forget rescore in profile.js normally
  // covers this within a few seconds of onboarding, but if a request
  // lands before that finishes (or before this candidate's very first
  // scheduled precompute run), do one synchronous scoring pass now
  // rather than showing an empty dashboard with no explanation. This
  // only ever runs once per candidate — after it succeeds, rows exist
  // and every future request hits the fast path above.
  if ((!rows || rows.length === 0)) {
    const { count } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("id", { count: "exact", head: true })
      .eq("candidate_id", profile.id);
    if (!count || count === 0) {
      try {
        await scoreAndStoreForCandidate(supabaseAdmin, profile);
        ({ data: rows, error } = await fetchScoredRows());
        if (error) return res.status(500).json({ error: error.message });
      } catch (err) {
        console.error(`Fallback synchronous scoring failed for candidate ${profile.id}: ${err.message}`);
      }
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

  res.json(isSubscribed(profile) ? results : results.map(redactForNonSubscriber));
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
router.get("/recruiter-jobs", requireConfig, optionalAuth, async (req, res) => {
  const { data: jobsData, error } = await supabaseAnon
    .from("jobs")
    .select("*")
    .eq("source_type", "recruiter_posted")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .order("first_seen_at", { ascending: false });
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
// Excellent Match is computed and stored per-job in
// candidate_job_matches.excellent_match by backend/matching.js — this
// just counts and adds the day-remaining math against
// subscription_started_at (set once, on first successful Stripe
// checkout — see backend/routes/stripe.js).
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
  const daysElapsed = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60 * 24);
  const daysRemaining = Math.max(0, Math.ceil(GUARANTEE_WINDOW_DAYS - daysElapsed));
  const windowOpen = daysElapsed <= GUARANTEE_WINDOW_DAYS;

  const { count } = await supabaseAdmin
    .from("candidate_job_matches")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", req.candidateId)
    .eq("excellent_match", true);

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
  const { data: job, error: jobError } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
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

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("id", req.candidateId)
    .maybeSingle();

  let resumeUrl = null;
  if (profile?.resume_file_path) {
    const { data: signed } = await supabaseAdmin.storage
      .from("resumes")
      .createSignedUrl(profile.resume_file_path, 60 * 60 * 24 * 14); // 14-day link, same pattern as any Storage-backed download elsewhere in the app
    resumeUrl = signed?.signedUrl || null;
  }

  const html = `
    <p><strong>${escapeHtmlServer(profile?.name || "A ROOK candidate")}</strong> applied to your posting on ROOK: <strong>${escapeHtmlServer(job.title_original || "this role")}</strong>.</p>
    ${coverLetter.split("\n").filter(Boolean).map((p) => `<p>${escapeHtmlServer(p)}</p>`).join("")}
    ${resumeUrl ? `<p><a href="${resumeUrl}">Download résumé</a> (link active 14 days)</p>` : "<p>No résumé is on file for this candidate.</p>"}
    <p style="color:#5B6B85; font-size:13px;">Reply directly to this email to reach the candidate${profile?.email ? ` at ${escapeHtmlServer(profile.email)}` : ""}${profile?.phone ? ` or ${escapeHtmlServer(profile.phone)}` : ""}.</p>
  `;

  try {
    await sendEmail({
      to: job.recruiter_email,
      subject: `New ROOK application: ${job.title_original || "your posting"}`,
      html,
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not deliver the application email: ${err.message}. Nothing was recorded — try again.` });
  }

  // Record the application for the candidate's own Application History —
  // no unique constraint on (candidate_id, job_id) in the schema, so
  // check-then-write rather than upsert.
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

  res.json({ ok: true });
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
      description_preview: (data.description_text || "").slice(0, 300),
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
