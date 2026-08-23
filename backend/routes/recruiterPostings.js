// Recruiter accounts and postings — a real Supabase Auth account per
// recruiter (recruiter_profiles), matching MedReps' actual model
// (employers log into a persistent account and manage their own
// postings) rather than the earlier version of this file, which
// accepted anonymous, no-account submissions.
//
// Auth pattern mirrors profile.js/jobs.js exactly: verify the caller's
// token with the ANON client, then read/write with the SERVICE ROLE
// client (RLS still protects direct Supabase access as a backstop —
// see schema.sql's recruiter_profiles policies — but routes here use
// the service role for the same reason every other authenticated route
// in this project does: consistent, predictable behavior regardless of
// RLS specifics).

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { analyzeJob } = require("../ai/jobAnalysis");
const { generateEmbedding } = require("../ai/embeddings");
const { geocodeLocation } = require("../geocoding");

const router = express.Router();

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const supabaseAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured) return res.status(503).json({ error: "Supabase isn't configured on this server yet." });
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

// Every route below needs the caller's recruiter_profiles.id, not their
// auth user id.
async function loadRecruiterId(req, res, next) {
  const { data, error } = await supabaseAdmin
    .from("recruiter_profiles")
    .select("id")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Complete your recruiter profile first" });
  req.recruiterId = data.id;
  next();
}

// GET /api/recruiter-profile
router.get("/recruiter-profile", requireConfig, requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("recruiter_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/recruiter-profile — create or update. Body: { name, email, company_name, phone }
router.put("/recruiter-profile", requireConfig, requireAuth, async (req, res) => {
  const payload = { ...req.body, user_id: req.user.id, updated_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin
    .from("recruiter_profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/my-recruiter-postings — every posting this recruiter owns,
// regardless of moderation status (pending/approved/rejected all show,
// so they can see where each one stands).
router.get("/my-recruiter-postings", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("recruiter_id", req.recruiterId)
    .order("first_seen_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/recruiter-postings — now requires a real recruiter account.
// Contact fields are pulled from the recruiter's own profile, not
// re-typed per submission.
router.post("/recruiter-postings", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data: recruiterProfile } = await supabaseAdmin
    .from("recruiter_profiles")
    .select("*")
    .eq("id", req.recruiterId)
    .single();

  const { job_title, description_text, location_raw, compensation_text, company_name, recruiter_contact_method } = req.body || {};
  if (!job_title || !description_text) {
    return res.status(400).json({ error: "job_title and description_text are required." });
  }

  const jobRow = {
    source_type: "recruiter_posted",
    source_job_id: `recruiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title_original: job_title,
    company_name: company_name || null,
    description_text,
    location_raw: location_raw || null,
    compensation_text: compensation_text || null,
    status: "active",
    moderation_status: "pending",
    source_verified: false,
    recruiter_id: req.recruiterId,
    recruiter_name: recruiterProfile.name,
    recruiter_email: recruiterProfile.email,
    recruiter_company: recruiterProfile.company_name,
    recruiter_contact_method: recruiter_contact_method || recruiterProfile.email,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabaseAdmin.from("jobs").insert(jobRow).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Best-effort AI analysis, embedding, geocoding — same as before, a
  // failure in any of these doesn't block the submission.
  try {
    const analysis = await analyzeJob(job_title, description_text);
    await supabaseAdmin.from("jobs").update({ ai_analysis: analysis }).eq("id", inserted.id);
  } catch (err) {
    console.error(`Recruiter posting AI analysis failed: ${err.message}`);
  }
  try {
    const embedding = await generateEmbedding(`${job_title}\n\n${description_text}`);
    await supabaseAdmin.from("jobs").update({ job_embedding: embedding }).eq("id", inserted.id);
  } catch (err) {
    console.error(`Recruiter posting embedding failed: ${err.message}`);
  }
  if (location_raw) {
    try {
      const coords = await geocodeLocation(location_raw);
      if (coords) await supabaseAdmin.from("jobs").update({ job_lat: coords.lat, job_lng: coords.lng }).eq("id", inserted.id);
    } catch (err) {
      console.error(`Recruiter posting geocoding failed: ${err.message}`);
    }
  }

  res.json({ ok: true, id: inserted.id, message: "Submitted for review. You'll see it live on your dashboard once approved." });
});

// GET /api/admin/recruiter-postings?status=pending — review queue
router.get("/admin/recruiter-postings", requireConfig, requireAuth, async (req, res) => {
  const status = req.query.status || "pending";
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("source_type", "recruiter_posted")
    .eq("moderation_status", status)
    .order("first_seen_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/admin/recruiter-postings/:id/approve", requireConfig, requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "approved" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/admin/recruiter-postings/:id/reject", requireConfig, requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "rejected" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
