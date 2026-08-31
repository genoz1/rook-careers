// GET /api/application-package/:jobId — generates a tailored application
// package (résumé summary, cover letter, recruiter message, interview
// prep) for the caller's résumé against one specific job.
//
// Cached in candidate_job_matches.generated_package — a real AI call
// happens once per candidate+job, not once per page visit. Pass
// ?regenerate=true to force a fresh generation (e.g. after updating a
// résumé, or if the candidate just wants a different take).

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { generateApplicationPackage } = require("../ai/applicationPackage");

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

router.get("/application-package/:jobId", requireConfig, requireAuth, async (req, res) => {
  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id, resume_text, name, email, phone")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile || !profile.resume_text) {
    return res.status(400).json({ error: "Upload a résumé before generating an application package — see onboarding Step 1." });
  }

  const { data: job, error: jobError } = await supabaseAdmin
    .from("jobs")
    .select("title_original, company_name, description_text")
    .eq("id", req.params.jobId)
    .maybeSingle();

  if (jobError) return res.status(500).json({ error: jobError.message });
  if (!job) return res.status(404).json({ error: "Job not found" });

  const forceRegenerate = req.query.regenerate === "true";

  if (!forceRegenerate) {
    const { data: cached } = await supabaseAdmin
      .from("candidate_job_matches")
      .select("generated_package, generated_package_at")
      .eq("candidate_id", profile.id)
      .eq("job_id", req.params.jobId)
      .maybeSingle();

    if (cached?.generated_package) {
      return res.json({
        ...cached.generated_package,
        job_title: job.title_original,
        company_name: job.company_name,
        resume_text: profile.resume_text,
        candidate_name: profile.name,
        candidate_email: profile.email,
        candidate_phone: profile.phone,
        cached: true,
        generated_at: cached.generated_package_at,
      });
    }
  }

  try {
    const pkg = await generateApplicationPackage(profile.resume_text, job.title_original, job.company_name, job.description_text);

    // Cache it — upsert since a candidate_job_matches row may or may not
    // already exist for this pair (e.g. from a save/dismiss action).
    await supabaseAdmin
      .from("candidate_job_matches")
      .upsert(
        {
          candidate_id: profile.id,
          job_id: req.params.jobId,
          generated_package: pkg,
          generated_package_at: new Date().toISOString(),
        },
        { onConflict: "candidate_id,job_id" }
      );

    res.json({
      ...pkg,
      job_title: job.title_original,
      company_name: job.company_name,
      resume_text: profile.resume_text,
      candidate_name: profile.name,
      candidate_email: profile.email,
      candidate_phone: profile.phone,
      cached: false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
