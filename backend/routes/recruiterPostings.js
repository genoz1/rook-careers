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

// Real bug this fixes: the three /admin/recruiter-postings routes below
// (list pending/approved/rejected, approve, reject) only ever checked
// requireAuth — meaning ANY signed-in account, candidate or recruiter,
// not just an actual admin, could call these and approve or reject job
// postings. There was no admin-specific check anywhere. This compares
// the caller's own verified email (from their Supabase Auth token,
// not anything client-supplied) against a comma-separated allowlist in
// the ADMIN_EMAILS environment variable.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

async function requireAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: "Not authorized." });
  }
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

// PUT /api/recruiter-postings/:id — edit an existing posting owned by
// this recruiter. Also refreshes the recruiter_name/email/company
// snapshot on the job from the recruiter's CURRENT profile — those
// fields are copied onto the job row at creation time and never
// updated automatically afterward, so if a recruiter's account email
// was wrong or has since changed, editing a posting is what actually
// propagates the correction to it (updating the account alone does
// not retroactively fix already-posted jobs).
router.put("/recruiter-postings/:id", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("jobs")
    .select("id, recruiter_id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (fetchError) return res.status(500).json({ error: fetchError.message });
  if (!existing) return res.status(404).json({ error: "Posting not found." });
  if (existing.recruiter_id !== req.recruiterId) {
    return res.status(403).json({ error: "You can only edit your own postings." });
  }

  const { data: recruiterProfile } = await supabaseAdmin
    .from("recruiter_profiles")
    .select("*")
    .eq("id", req.recruiterId)
    .single();

  const { job_title, description_text, location_raw, compensation_text, company_name, recruiter_contact_method } = req.body || {};
  if (!job_title || !description_text) {
    return res.status(400).json({ error: "job_title and description_text are required." });
  }

  const updateRow = {
    title_original: job_title,
    company_name: company_name || null,
    description_text,
    location_raw: location_raw || null,
    compensation_text: compensation_text || null,
    recruiter_name: recruiterProfile.name,
    recruiter_email: recruiterProfile.email,
    recruiter_company: recruiterProfile.company_name,
    recruiter_contact_method: recruiter_contact_method || recruiterProfile.email,
    // Edited content should go back through review, same as a new
    // submission — don't let an edited posting stay live under the
    // moderation status a completely different version of it earned.
    moderation_status: "pending",
  };

  const { error: updateError } = await supabaseAdmin.from("jobs").update(updateRow).eq("id", req.params.id);
  if (updateError) return res.status(500).json({ error: updateError.message });

  // Re-run AI analysis/embedding/geocoding on the updated content —
  // best-effort, same as the original POST route, a failure here
  // doesn't block the edit itself from saving.
  try {
    const analysis = await analyzeJob(job_title, description_text);
    await supabaseAdmin.from("jobs").update({ ai_analysis: analysis }).eq("id", req.params.id);
  } catch (err) {
    console.error(`Recruiter posting edit AI analysis failed: ${err.message}`);
  }
  try {
    const embedding = await generateEmbedding(`${job_title}\n\n${description_text}`);
    await supabaseAdmin.from("jobs").update({ job_embedding: embedding }).eq("id", req.params.id);
  } catch (err) {
    console.error(`Recruiter posting edit embedding failed: ${err.message}`);
  }
  if (location_raw) {
    try {
      const coords = await geocodeLocation(location_raw);
      if (coords) await supabaseAdmin.from("jobs").update({ job_lat: coords.lat, job_lng: coords.lng }).eq("id", req.params.id);
    } catch (err) {
      console.error(`Recruiter posting edit geocoding failed: ${err.message}`);
    }
  }

  res.json({ ok: true, message: "Updated and resubmitted for review." });
});

// POST /api/recruiter-postings/:id/close — take a posting down. Marks
// it closed rather than deleting it, same "never hard-delete, just
// mark inactive" principle used for every other job source in ROOK —
// keeps the row (and any candidate application history tied to it)
// intact.
router.post("/recruiter-postings/:id/close", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data: existing } = await supabaseAdmin
    .from("jobs")
    .select("id, recruiter_id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: "Posting not found." });
  if (existing.recruiter_id !== req.recruiterId) {
    return res.status(403).json({ error: "You can only manage your own postings." });
  }
  const { error } = await supabaseAdmin.from("jobs").update({ status: "closed" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/recruiter-postings/:id/reactivate — bring a closed posting
// back. Goes back to pending review, same as an edit, rather than
// silently reappearing under whatever moderation status it had before.
router.post("/recruiter-postings/:id/reactivate", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data: existing } = await supabaseAdmin
    .from("jobs")
    .select("id, recruiter_id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: "Posting not found." });
  if (existing.recruiter_id !== req.recruiterId) {
    return res.status(403).json({ error: "You can only manage your own postings." });
  }
  const { error } = await supabaseAdmin.from("jobs").update({ status: "active", moderation_status: "pending" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/recruiter-postings/:id — a single posting, for the edit form.
router.get("/recruiter-postings/:id", requireConfig, requireAuth, loadRecruiterId, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Posting not found." });
  if (data.recruiter_id !== req.recruiterId) {
    return res.status(403).json({ error: "You can only view your own postings." });
  }
  res.json(data);
});

// GET /api/admin/recruiter-postings?status=pending — review queue
router.get("/admin/recruiter-postings", requireConfig, requireAuth, requireAdmin, async (req, res) => {
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

router.post("/admin/recruiter-postings/:id/approve", requireConfig, requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "approved" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/admin/recruiter-postings/:id/reject", requireConfig, requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from("jobs").update({ moderation_status: "rejected" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
