// Application tracking routes — the "applications" table already existed
// in the schema (with RLS policies) but nothing read or wrote to it
// until now. This is what powers the Application Tracker page and the
// dashboard's "Applications In Progress" stat, and feeds application-
// history awareness back into job browsing (see jobs.js).

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

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = data.user;
  next();
}

// Every route here needs the caller's candidate_profiles.id, not their
// auth user id — applications.candidate_id references that, not auth.users.
async function loadCandidateId(req, res, next) {
  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Complete onboarding before tracking applications" });
  req.candidateId = data.id;
  next();
}

// GET /api/applications — the caller's applications, joined with full
// job info and their precomputed match score (see
// backend/scoring/precompute.js), so the Tracker page can show a score
// per card without a second round trip. Applications are always a small
// set per candidate, so unlike the main job listing, this just looks up
// precomputed scores for the specific jobs involved directly rather than
// doing a big join — with a live scoreJob() fallback for the rare case
// where a job's precomputed row doesn't exist yet.
router.get("/applications", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("applications")
    .select("*, jobs(*)")
    .eq("candidate_id", req.candidateId)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  const jobIds = data.map((app) => app.jobs?.id).filter(Boolean);
  const { data: matchRows } = jobIds.length > 0
    ? await supabaseAdmin
        .from("candidate_job_matches")
        .select("*")
        .eq("candidate_id", req.candidateId)
        .in("job_id", jobIds)
    : { data: [] };
  const matchByJobId = new Map((matchRows || []).map((row) => [row.job_id, row]));

  const withScores = data.map((app) => {
    if (!app.jobs) return app;
    const row = matchByJobId.get(app.jobs.id);
    const match = row
      ? {
          overall_score: row.overall_score,
          candidate_fit: row.candidate_fit,
          preference_fit: row.preference_fit,
          recommendation: row.recommendation,
          reasons: row.reasons || [],
          concerns: row.concerns || [],
          confidence: row.confidence,
          hard_disqualifier: row.hard_disqualifier,
        }
      : profile
        ? scoreJob(app.jobs, profile) // fallback: no precomputed row yet for this job
        : null;
    return { ...app, jobs: { ...app.jobs, match } };
  });

  res.json(withScores);
});

// POST /api/applications — create or update the caller's application for
// a given job. Body: { job_id, status, notes?, follow_up_date? }.
// There's no unique(candidate_id, job_id) constraint on this table (only
// candidate_job_matches has one), so this does a manual check-then-write
// rather than relying on upsert's onConflict — avoids needing a schema
// migration just for this.
router.post("/applications", requireConfig, requireAuth, loadCandidateId, async (req, res) => {
  const { job_id, status, notes, follow_up_date } = req.body;
  if (!job_id) return res.status(400).json({ error: "job_id is required" });

  const { data: existing } = await supabaseAdmin
    .from("applications")
    .select("id")
    .eq("candidate_id", req.candidateId)
    .eq("job_id", job_id)
    .maybeSingle();

  const payload = {
    candidate_id: req.candidateId,
    job_id,
    updated_at: new Date().toISOString(),
  };
  if (status !== undefined) payload.status = status;
  if (notes !== undefined) payload.notes = notes;
  if (follow_up_date !== undefined) payload.follow_up_date = follow_up_date;
  if (status === "applied" && !existing) payload.applied_at = new Date().toISOString();

  let result;
  if (existing) {
    result = await supabaseAdmin.from("applications").update(payload).eq("id", existing.id).select().single();
  } else {
    result = await supabaseAdmin.from("applications").insert(payload).select().single();
  }

  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json(result.data);
});

module.exports = router;
