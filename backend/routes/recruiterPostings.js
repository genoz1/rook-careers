// Recruiter-submitted job postings — a free, public submission form
// (no ROOK account needed) that lands new rows directly in the `jobs`
// table with source_type='recruiter_posted', reusing every existing
// piece of ROOK's pipeline (scoring, saving, dismissing, the
// subscription paywall) instead of building a parallel system.
//
// Unlike every ATS-pulled job (already verified by virtue of coming
// straight from the employer's own system), a recruiter can submit
// literally anything through a public form — moderation_status keeps a
// new submission invisible to candidates ('pending') until a human
// explicitly approves it via the admin review page. This is the one
// real safeguard protecting ROOK's core "verified, not junk like
// LinkedIn" promise now that an open submission channel exists at all.

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

// Only used for the admin review endpoints below — the public
// submission endpoint deliberately requires no auth at all, since
// recruiters aren't ROOK candidate accounts.
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = data.user;
  next();
}

// POST /api/recruiter-postings — public submission form. No auth.
router.post("/recruiter-postings", requireConfig, async (req, res) => {
  const {
    recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method,
    job_title, description_text, location_raw, compensation_text, company_name,
  } = req.body || {};

  if (!recruiter_name || !recruiter_email || !job_title || !description_text) {
    return res.status(400).json({ error: "recruiter_name, recruiter_email, job_title, and description_text are all required." });
  }

  const jobRow = {
    source_type: "recruiter_posted",
    source_job_id: `recruiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title_original: job_title,
    company_name: company_name || null, // may be intentionally left blank for a confidential search
    description_text,
    location_raw: location_raw || null,
    compensation_text: compensation_text || null,
    status: "active",
    moderation_status: "pending", // stays invisible to candidates until approved
    source_verified: false,
    recruiter_name,
    recruiter_email,
    recruiter_company: recruiter_company || null,
    recruiter_contact_method: recruiter_contact_method || null,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };

  const { data: inserted, error } = await supabaseAdmin.from("jobs").insert(jobRow).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Best-effort AI analysis, embedding, and geocoding — same pipeline
  // every ATS-ingested job goes through, just run inline here since
  // it's a single submission, not a batch. A failure in any of these
  // doesn't block the submission itself; the posting still gets saved
  // and reviewed, just without that piece of AI-derived data until a
  // later precompute pass (or never, if it keeps failing — same
  // graceful-degradation approach as ingestion).
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

  res.json({ ok: true, id: inserted.id, message: "Submitted for review. You'll see it live once approved." });
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

// POST /api/admin/recruiter-postings/:id/approve
router.post("/admin/recruiter-postings/:id/approve", requireConfig, requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "approved" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/admin/recruiter-postings/:id/reject
router.post("/admin/recruiter-postings/:id/reject", requireConfig, requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "rejected" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
