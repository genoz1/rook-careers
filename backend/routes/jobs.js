// Public job-listing routes. No auth required — anyone can browse jobs,
// same as the public site. Matching against a specific candidate happens
// in a separate route once the matching engine (Phase 1.5) exists.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

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

// GET /api/jobs?industry=Veterinary&state=FL&limit=20
router.get("/jobs", requireConfig, async (req, res) => {
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
  res.json(data);
});

// GET /api/jobs/:id
router.get("/jobs/:id", requireConfig, async (req, res) => {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Job not found" });
  res.json(data);
});

module.exports = router;
