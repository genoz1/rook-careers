// GET /api/geocode?q=<text> — lets the frontend geocode an arbitrary
// place name on demand, used by the Job Search page's "show jobs near a
// place" feature (searching near somewhere other than the candidate's
// saved home ZIP — e.g. "what's available in Tampa" even if they live
// in Oxford). Kept server-side (not called directly from the browser)
// so the real request to OpenStreetMap's Nominatim goes through the
// same throttled, User-Agent-labeled client as ingestion's job
// geocoding — calling Nominatim directly from a browser would violate
// their usage policy and is also blocked by CORS in practice.
//
// Requires auth — this makes a real outbound network call per request,
// so it shouldn't be left open to anonymous abuse.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { geocodeLocation } = require("../geocoding");

const router = express.Router();

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabaseAnon = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

async function requireAuth(req, res, next) {
  if (!isConfigured) return res.status(503).json({ error: "Supabase isn't configured on this server yet." });
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  next();
}

router.get("/geocode", requireAuth, async (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "Missing ?q= query text" });

  try {
    const coords = await geocodeLocation(query);
    if (!coords) return res.status(404).json({ error: `Could not find a location matching "${query}"` });
    res.json(coords);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
