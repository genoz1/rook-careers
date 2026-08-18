// Public job-listing routes. Auth is optional here: signed-out visitors
// can browse jobs same as before, but a signed-in candidate gets each
// job scored against their profile — see backend/matching.js.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { scoreJob } = require("../matching");

const router = express.Router();

// Guard against missing config — see backend/routes/stripe.js for why this
// pattern matters (createClient throws synchronously on an undefined URL).
const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabase = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured) {
    return res.status(503).json({ error: "Supabase isn't configured on this server yet. See ROOK-Setup-Guide.pdf." });
  }
  next();
}

// Optional auth: attaches req.user if a valid token is present, but never
// blocks the request if it's missing or invalid — job browsing stays
// public either way, matching gets added on top when possible.
async function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return next();
  const { data } = await supabase.auth.getUser(token);
  if (data?.user) req.user = data.user;
  next();
}

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, optionalAuth, async (req, res) => {
  const { industry, state, limit = 20 } = req.query;

  let query = supabase
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

  // Signed in — attach a real match score per job using their profile.
  const { data: profile } = await supabase
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile) return res.json(data);

  const scored = data
    .map((job) => ({ ...job, match: scoreJob(job, profile) }))
    .sort((a, b) => (b.match.overall_score ?? -1) - (a.match.overall_score ?? -1));

  res.json(scored);
});

// GET /api/jobs/:id
router.get("/jobs/:id", requireConfig, optionalAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Job not found" });

  if (!req.user) return res.json(data);

  const { data: profile } = await supabase
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  res.json(profile ? { ...data, match: scoreJob(data, profile) } : data);
});

module.exports = router;
