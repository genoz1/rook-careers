// Public job-listing routes. Auth is optional here: signed-out visitors
// can browse jobs same as before, but a signed-in candidate gets each
// job scored against their profile — see backend/matching.js.
//
// Auth model: same as profile.js — verify the caller's token with the
// ANON client, then look up their profile with the SERVICE ROLE client.
// Using the anon client for the profile lookup silently returns nothing
// (row-level security correctly blocks it), because verifying a token
// with supabase.auth.getUser() does NOT make subsequent queries on that
// same client run "as" that user — that was the actual bug here: match
// scores were never attaching because this profile lookup was always
// coming back empty, not because the scoring logic was wrong.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { scoreJob } = require("../matching");

const router = express.Router();

// Guard against missing config — see backend/routes/stripe.js for why this
// pattern matters (createClient throws synchronously on an undefined URL).
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

// Optional auth: attaches req.user if a valid token is present, but never
// blocks the request if it's missing or invalid — job browsing stays
// public either way, matching gets added on top when possible.
async function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  console.log(`[jobs] Authorization header present: ${Boolean(token)}`);
  if (!token) return next();
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) console.log(`[jobs] token verification failed: ${error.message}`);
  if (data?.user) {
    req.user = data.user;
    console.log(`[jobs] authenticated as user ${data.user.id}`);
  }
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

  if (!req.user) {
    console.log("[jobs] no authenticated user — returning unscored jobs");
    return res.json(data);
  }

  // Signed in — attach a real match score per job using their profile.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (profileError) console.log(`[jobs] profile lookup error: ${profileError.message}`);
  console.log(`[jobs] profile found for user ${req.user.id}: ${Boolean(profile)}`);

  if (!profile) return res.json(data);

  const scored = data
    .map((job) => ({ ...job, match: scoreJob(job, profile) }))
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

module.exports = router;
