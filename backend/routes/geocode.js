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

// ── GET /api/location-search?q=<text> ────────────────────────────────────────
// Returns up to 5 formatted U.S. location suggestions for the given query.
// Used by the onboarding "Where do you want to work?" screen AND the dashboard
// location-change widget — both need it before or without an authenticated session,
// so this endpoint does not require auth.
//
// Abuse protection: simple IP-based rate limit (10 requests per 30 seconds).
// All Nominatim calls still go through the same throttled client in geocoding.js
// (≤1 req/sec) so the rate limit here is a secondary guard against bursts.
//
// Accepts:
//   - Five-digit US ZIP:          "34484"   → [{ label:"34484 — Oxford, FL", ... }]
//   - City + full state:          "Boise, Idaho"
//   - City + state abbreviation:  "Boise, ID"
//   - Partial city name:          "Boise"
//
// Returns array of { label, city, state, stateAbbr, lat, lng, zip } objects.
// "zip" is the Nominatim-reported postal code for the result area (may be null).
// The frontend MUST require the user to select a suggestion; it must NOT silently
// accept the first result on an arbitrary keypress.

const USER_AGENT_LS = "ROOK-Careers/1.0 (rookcareers.com; location-search)";
const REQUEST_TIMEOUT_LS = 8_000;

// US state name → abbreviation map (mirrors backend/matching.js for consistency)
const STATE_ABBR_MAP = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
  "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
  "kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD",
  "massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS","missouri":"MO",
  "montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH",
  "oklahoma":"OK","oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
  "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
  "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
};

function stateToAbbr(stateName) {
  if (!stateName) return null;
  const key = stateName.trim().toLowerCase();
  if (STATE_ABBR_MAP[key]) return STATE_ABBR_MAP[key];
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase(); // already an abbr
  return null;
}

function stateFromAbbr(abbr) {
  if (!abbr) return null;
  const up = abbr.trim().toUpperCase();
  for (const [name, a] of Object.entries(STATE_ABBR_MAP)) {
    if (a === up) return name.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  }
  return null;
}

function formatCandidate(raw) {
  // Extract city from address (Nominatim uses different keys by place type)
  const addr = raw.address || {};
  const city  = addr.city || addr.town || addr.village || addr.hamlet || addr.county || null;
  const state = addr.state || null;
  const zip   = addr.postcode || null;
  const abbr  = stateToAbbr(state);
  const lat   = parseFloat(raw.lat);
  const lng   = parseFloat(raw.lon);

  if (!state || !abbr || isNaN(lat) || isNaN(lng)) return null;
  // Filter to US only (Nominatim with countrycodes=us should guarantee this, but double-check)
  if (addr.country_code && addr.country_code !== "us") return null;

  let label;
  const isZipResult = raw.type === "postcode" || (zip && raw.display_name?.startsWith(zip));
  if (isZipResult && zip && city) {
    label = `${zip} — ${city}, ${abbr}`;
  } else if (city) {
    label = `${city}, ${abbr}`;
  } else {
    label = abbr; // last resort
  }

  return { label, city: city || null, state, stateAbbr: abbr, lat, lng, zip: zip || null };
}

async function nominatimFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_LS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT_LS },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// In-memory IP rate limiter: 10 requests per 30 seconds per IP.
// Resets per-IP after 30 seconds of inactivity.
const LS_RATE = new Map(); // ip → { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = LS_RATE.get(ip);
  if (!entry || now > entry.resetAt) {
    LS_RATE.set(ip, { count: 1, resetAt: now + 30_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}
// Prune stale entries every 5 minutes to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of LS_RATE.entries()) { if (now > e.resetAt) LS_RATE.delete(ip); }
}, 300_000);

// Simple global Nominatim throttle for this route (separate from geocoding.js's
// throttle, which is used by ingestion). Nominatim policy: ≤1 req/sec.
let lsLastCall = 0;
async function lsThrottle() {
  const wait = 1100 - (Date.now() - lsLastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lsLastCall = Date.now();
}

router.get("/location-search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) return res.json([]);

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests. Try again shortly." });

  try {
    await lsThrottle();

    let results;
    const isZip = /^\d{5}$/.test(q);

    if (isZip) {
      // ZIP code input: use Nominatim's postal-code search
      const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(q)}&country=us&format=json&limit=1&addressdetails=1`;
      results = await nominatimFetch(url);
    } else {
      // City / city+state input: free-text search restricted to US
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&countrycodes=us&format=json&limit=7&addressdetails=1`;
      results = await nominatimFetch(url);
    }

    const seen = new Set();
    const suggestions = [];
    for (const r of results) {
      const c = formatCandidate(r);
      if (!c || seen.has(c.label)) continue;
      seen.add(c.label);
      suggestions.push(c);
      if (suggestions.length >= 5) break;
    }

    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
