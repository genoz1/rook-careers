// Admin route for adding employers without touching Supabase directly.
//
// SECURITY NOTE: this only requires the caller to be a signed-in ROOK user,
// not a specific "admin" role — there's no admin/role concept in the schema
// yet. That's an acceptable tradeoff while you're effectively the only
// user, but before opening ROOK to other candidates, this route needs a
// real admin check (e.g. an is_admin column on candidate_profiles) so any
// signed-up candidate can't add or see employer rows.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const isConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAnon = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
const supabaseAdmin = isConfigured
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

// Detects the ATS type and extracts the identifier from a careers URL.
// Returns { ats_type, ats_identifier } or null if the URL doesn't match
// any supported pattern.
function detectAts(url) {
  let m;

  m = url.match(/(?:job-boards|boards)\.greenhouse\.io\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "greenhouse", ats_identifier: m[1] };

  m = url.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "lever", ats_identifier: m[1] };

  m = url.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "ashby", ats_identifier: m[1] };

  m = url.match(/^https?:\/\/([a-zA-Z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "workday", ats_identifier: `${m[1]}|${m[2]}|${m[3]}` };

  m = url.match(/apply\.workable\.com\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "workable", ats_identifier: m[1] };

  m = url.match(/(?:careers|jobs)\.smartrecruiters\.com\/([a-zA-Z0-9_-]+)/);
  if (m) return { ats_type: "smartrecruiters", ats_identifier: m[1] };

  return null;
}

// POST /api/admin/employers
// Body: { company_name, careers_url, priority?, ats_type_override? }
//
// ats_type_override lets you manually specify the platform when
// auto-detection can't work — needed for TalentBrew and ClinchTalent,
// since (unlike Workday/Workable/SmartRecruiters, which share a common
// domain per platform) every TalentBrew or ClinchTalent employer hosts on
// their own domain, so there's no URL pattern to detect it by. Pass
// ats_type_override: "talentbrew" or "clinchtalent" and careers_url as
// the employer's careers-site URL (e.g. https://careers.questdiagnostics.com
// or https://careers.foundationmedicine.com).
router.post("/admin/employers", requireConfig, requireAuth, async (req, res) => {
  const { company_name, careers_url, priority, ats_type_override } = req.body || {};
  if (!company_name || !careers_url) {
    return res.status(400).json({ error: "company_name and careers_url are required" });
  }

  let detected;
  if (ats_type_override === "talentbrew" || ats_type_override === "clinchtalent") {
    try {
      const hostname = new URL(careers_url.trim()).hostname;
      detected = { ats_type: ats_type_override, ats_identifier: hostname };
    } catch {
      return res.status(400).json({ error: "careers_url isn't a valid URL." });
    }
  } else {
    detected = detectAts(careers_url.trim());
  }

  if (!detected) {
    return res.status(422).json({
      error:
        "Couldn't detect a supported ATS from that URL. Supported patterns: " +
        "job-boards.greenhouse.io/..., jobs.lever.co/..., jobs.ashbyhq.com/..., " +
        "*.wdN.myworkdayjobs.com/..., apply.workable.com/..., careers.smartrecruiters.com/... " +
        "— or set ats_type_override to \"talentbrew\" or \"clinchtalent\" " +
        "for employers on those platforms' own custom domains.",
    });
  }

  const company_slug = company_name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const { data, error } = await supabaseAdmin
    .from("employers")
    .upsert(
      {
        company_name: company_name.trim(),
        company_slug,
        careers_url,
        ats_type: detected.ats_type,
        ats_identifier: detected.ats_identifier,
        active: true,
        priority: priority || "normal",
      },
      { onConflict: "company_slug" }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/employers — list existing employers (for the admin page)
router.get("/admin/employers", requireConfig, requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("employers")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
