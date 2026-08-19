// Public job-listing routes. Auth is optional here: signed-out visitors
// can browse jobs same as before, but a signed-in candidate gets each
// job scored against their profile — see backend/matching.js.
//
// Auth model: same as profile.js — verify the caller's token with the
// ANON client, then look up their profile with the SERVICE ROLE client.
// Using the anon client for the profile lookup silently returns nothing
// (row-level security correctly blocks it), because verifying a token
// with supabase.auth.getUser() does NOT make subsequent queries on that
// same client run "as" that user.
//
// Application/dismissal awareness: jobs a candidate has dismissed are
// filtered out of results entirely (spec factor #48's practical intent
// — "don't show jobs like this"); jobs they've saved or applied to are
// annotated so the frontend can show the right button state, and applied
// jobs are excluded from "New Matches" counting logic on the frontend.
// This is done here in the route, not inside scoreJob() itself — keeping
// scoreJob's signature to just (job, profile) means it stays a pure,
// easily-testable function; list-level filtering/annotation belongs at
// the query layer instead.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { scoreJob } = require("../matching");

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

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, optionalAuth, async (req, res) => {
  const { industry, state, limit = 20 } = req.query;

  let query = supabaseAnon
    .from("jobs")
    .select("*")
    .eq("status", "active")
    .order("date_posted", { ascending: false })
    .limit(Number(limit));

  if (industry) query = query.eq("industry", industry);
  if (state) query = query.eq("state", state);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  if (!req.user) return res.json(data);

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile) return res.json(data);

  // Pull dismissed/saved state and application status for this candidate
  // in two extra queries, rather than N+1 queries per job.
  const [{ data: matchRows }, { data: appRows }] = await Promise.all([
    supabaseAdmin.from("candidate_job_matches").select("job_id, dismissed, saved").eq("candidate_id", profile.id),
    supabaseAdmin.from("applications").select("job_id, status").eq("candidate_id", profile.id),
  ]);

  const dismissedIds = new Set((matchRows || []).filter((m) => m.dismissed).map((m) => m.job_id));
  const savedIds = new Set((matchRows || []).filter((m) => m.saved).map((m) => m.job_id));
  const appStatusByJob = new Map((appRows || []).map((a) => [a.job_id, a.status]));

  const scored = data
    .filter((job) => !dismissedIds.has(job.id))
    .map((job) => ({
      ...job,
      match: scoreJob(job, profile),
      saved: savedIds.has(job.id),
      application_status: appStatusByJob.get(job.id) || null,
    }))
    .sort((a, b) => (b.match.overall_score ?? -1) - (a.match.overall_score ?? -1));

  res.json(scored);
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

  if (!req.user) return res.json(data);

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  res.json(profile ? { ...data, match: scoreJob(data, profile) } : data);
});

// POST /api/jobs/:id/save — toggle whether this job is saved. Body: { saved: true|false }.
router.post("/jobs/:id/save", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const saved = req.body.saved !== false;
  const { data, error } = await supabaseAdmin
    .from("candidate_job_matches")
    .upsert(
      { candidate_id: req.candidateId, job_id: req.params.id, saved, calculated_at: new Date().toISOString() },
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
      { candidate_id: req.candidateId, job_id: req.params.id, dismissed, calculated_at: new Date().toISOString() },
      { onConflict: "candidate_id,job_id" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
