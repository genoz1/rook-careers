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
// Returns up to 5 U.S. location suggestions from a bundled local dataset.
//
// Data source: the 'zipcodes' npm package (v8.x, BSD license).
//   https://www.npmjs.com/package/zipcodes
//   Bundled U.S. ZIP/city/state/lat/lng data derived from USPS ZIP Code data.
//   No external API calls. No recurring cost. No Nominatim or paid geocoding.
//
// Used by the onboarding "Where do you want to work?" screen (pre-auth) and
// the dashboard location-change widget (authenticated). Because autocomplete
// results come from the local dataset rather than an external API, the main
// concern is DoS via sustained request volume — addressed by the IP rate limit.
//
// Accepts:
//   "34484"         -> exact ZIP lookup
//   "Boise, ID"     -> city + state abbreviation
//   "Boise, Idaho"  -> city + full state name
//   "Boise"         -> prefix match across all cities
//
// Returns array of { label, city, state, stateAbbr, lat, lng, zip }.
// Always US-only. The 'zip' field is the representative ZIP for the city.

const zipcodes = require("zipcodes");

// Build a deduplicated city index once at startup (31 k entries -> ~600 ms, cached).
// Key: "City|ST", value: first ZIP record for that city.
let _cityIndex = null;
function getCityIndex() {
  if (_cityIndex) return _cityIndex;
  _cityIndex = new Map();
  const US_ABBRS = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
    "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
    "WV","WI","WY",
  ]);
  for (const entry of Object.values(zipcodes.codes)) {
    if (!US_ABBRS.has(entry.state)) continue; // exclude Canadian entries in the dataset
    const key = entry.city + "|" + entry.state;
    if (!_cityIndex.has(key)) _cityIndex.set(key, entry);
  }
  return _cityIndex;
}

// US state name -> abbreviation (mirrors backend/matching.js for consistency)
const STATE_NAME_TO_ABBR = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR",
  "pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
};

function stateNameToAbbr(name) {
  return STATE_NAME_TO_ABBR[name.trim().toLowerCase()] || null;
}

function abbrToStateName(abbr) {
  const up = abbr.toUpperCase();
  for (const [name, a] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (a === up) return name.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  }
  return null;
}

function entryToSuggestion(entry) {
  // Representative ZIP for this city (entry.zip from the dataset)
  const stateAbbr = entry.state;
  const stateName = abbrToStateName(stateAbbr) || stateAbbr;
  return {
    label: `${entry.city}, ${stateAbbr}`,
    city: entry.city,
    state: stateName,
    stateAbbr,
    lat: entry.latitude,
    lng: entry.longitude,
    zip: entry.zip,
  };
}

function zipToSuggestion(entry) {
  const stateAbbr = entry.state;
  const stateName = abbrToStateName(stateAbbr) || stateAbbr;
  return {
    label: `${entry.zip} \u2014 ${entry.city}, ${stateAbbr}`,
    city: entry.city,
    state: stateName,
    stateAbbr,
    lat: entry.latitude,
    lng: entry.longitude,
    zip: entry.zip,
  };
}

// ZIP count cache — built once, reused across all searches.
let _zipCount = null;
function getZipCount() {
  if (_zipCount) return _zipCount;
  _zipCount = {};
  for (const e of Object.values(zipcodes.codes)) {
    const k = e.city + "|" + e.state;
    _zipCount[k] = (_zipCount[k] || 0) + 1;
  }
  return _zipCount;
}

// Sort city matches: larger cities (more ZIPs) first, then alphabetical by state.
function sortCityMatches(matches) {
  const zc = getZipCount();
  matches.sort((a, b) => {
    const diff = (zc[b.city+"|"+b.state] || 0) - (zc[a.city+"|"+a.state] || 0);
    return diff !== 0 ? diff : a.state.localeCompare(b.state);
  });
  return matches;
}

// Case-insensitive city prefix search, optionally filtered to one state.
function cityPrefixSearch(cityQuery, stateAbbr = null) {
  const idx = getCityIndex();
  const lower = cityQuery.toLowerCase();
  const matches = [];
  for (const entry of idx.values()) {
    if (stateAbbr && entry.state !== stateAbbr) continue;
    if (entry.city.toLowerCase().startsWith(lower)) matches.push(entry);
  }
  return sortCityMatches(matches).slice(0, stateAbbr ? 5 : 8).map(entryToSuggestion);
}

function searchLocal(q) {
  const trimmed = q.trim();

  // --- Exact 5-digit ZIP ---
  if (/^\d{5}$/.test(trimmed)) {
    const r = zipcodes.lookup(trimmed);
    return r ? [zipToSuggestion(r)] : [];
  }

  // --- "City, ST", "City, State Name", "City ST" (space-separated) ---
  // Handles all formats case-insensitively:
  //   "dallas, tx"  "Dallas, TX"  "dallas tx"  "Dallas TX"  "dallas, texas"
  const commaIdx = trimmed.lastIndexOf(",");
  const hasComma = commaIdx > 0;
  const parts    = hasComma
    ? [trimmed.slice(0, commaIdx).trim(), trimmed.slice(commaIdx + 1).trim()]
    : trimmed.split(/\s+/);

  if (parts.length >= 2) {
    const lastPart  = parts[parts.length - 1];
    const cityPart  = parts.slice(0, parts.length - 1).join(" ").trim();
    // Detect "ST" (2-letter abbr) or full state name as the last token
    const abbr = /^[A-Za-z]{2}$/.test(lastPart)
      ? lastPart.toUpperCase()
      : stateNameToAbbr(lastPart);
    if (abbr && cityPart.length >= 2) {
      const results = cityPrefixSearch(cityPart, abbr);
      if (results.length) return results;
    }
  }

  // --- Plain prefix city name search (no state hint) ---
  return cityPrefixSearch(trimmed);
}

// Prime the city index at startup so the first user request is fast
setImmediate(() => { try { getCityIndex(); } catch(_) {} });

// In-memory IP rate limit: 15 requests per 30 s per IP.
const LS_RATE = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = LS_RATE.get(ip);
  if (!entry || now > entry.resetAt) {
    LS_RATE.set(ip, { count: 1, resetAt: now + 30_000 });
    return true;
  }
  if (entry.count >= 15) return false;
  entry.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of LS_RATE.entries()) { if (now > e.resetAt) LS_RATE.delete(ip); }
}, 300_000);

router.get("/location-search", (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q || q.length < 2) return res.json([]);

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests. Try again shortly." });

  try {
    const suggestions = searchLocal(q);
    res.json(suggestions);
  } catch (err) {
    res.status(500).json({ error: "Location search unavailable." });
  }
});

module.exports = router;
