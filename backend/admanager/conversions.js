// ROOK Ad Manager — Server-side conversion event tracking
//
// Records first-party conversion events to ad_conversion_events.
// Deduplicates by event_key = userId + eventType + date.
// Mounted as /api/adtrack/* in server.js.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const router = express.Router();

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const VALID_EVENTS = [
  "landing_page_view",
  "onboarding_started",
  "onboarding_completed",
  "trial_started",
  "paid_subscription_started",
];

function hashString(str) {
  return str ? crypto.createHash("sha256").update(str).digest("hex").slice(0, 16) : null;
}

function inferPlatform(utm) {
  const src = (utm.utm_source || "").toLowerCase();
  if (src === "google" || utm.gclid) return "google";
  if (src === "facebook" || src === "meta" || utm.fbclid) return "meta";
  if (src === "reddit" || utm.reddit_click_id) return "reddit";
  if (src) return src;
  return "organic";
}

/**
 * POST /api/adtrack/event
 *
 * Body:
 *   event_type       string  required
 *   user_id          string  optional (authenticated users)
 *   anonymous_id     string  optional (browser/session fingerprint)
 *   utm_source       string  optional
 *   utm_medium       string  optional
 *   utm_campaign     string  optional
 *   utm_term         string  optional
 *   utm_content      string  optional
 *   gclid            string  optional (Google click ID from URL)
 *   fbclid           string  optional (Meta click ID from URL)
 *   reddit_click_id  string  optional
 *   occurred_at      string  optional ISO timestamp
 */
router.post("/adtrack/event", async (req, res) => {
  if (!isConfigured) return res.status(503).json({ error: "not configured" });

  const {
    event_type, user_id, anonymous_id,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    gclid, fbclid, reddit_click_id,
    occurred_at,
  } = req.body || {};

  if (!event_type || !VALID_EVENTS.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of: ${VALID_EVENTS.join(", ")}` });
  }

  const now = occurred_at || new Date().toISOString();
  const date = now.slice(0, 10);
  const key_parts = [user_id || anonymous_id || "anon", event_type, date].join("|");
  const event_key = crypto.createHash("sha256").update(key_parts).digest("hex").slice(0, 32);

  const utm = { utm_source, utm_medium, utm_campaign, utm_term, utm_content };
  const platform_inferred = inferPlatform({ ...utm, gclid, fbclid, reddit_click_id });

  // Get real IP from request (hashed — never stored raw)
  const rawIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "";
  const ip_hash = hashString(rawIp);
  const ua_hash = hashString(req.headers["user-agent"] || "");

  const { error } = await supabase.from("ad_conversion_events").upsert({
    event_key,
    event_type,
    user_id: user_id || null,
    anonymous_id: anonymous_id || null,
    utm_source:   utm_source   ? utm_source.slice(0, 100)   : null,
    utm_medium:   utm_medium   ? utm_medium.slice(0, 100)   : null,
    utm_campaign: utm_campaign ? utm_campaign.slice(0, 100) : null,
    utm_term:     utm_term     ? utm_term.slice(0, 100)     : null,
    utm_content:  utm_content  ? utm_content.slice(0, 100)  : null,
    gclid:            gclid            ? gclid.slice(0, 200)            : null,
    fbclid:           fbclid           ? fbclid.slice(0, 200)           : null,
    reddit_click_id:  reddit_click_id  ? reddit_click_id.slice(0, 200)  : null,
    platform_inferred,
    ip_hash,
    user_agent_hash: ua_hash,
    occurred_at: now,
  }, { onConflict: "event_key", ignoreDuplicates: true });

  if (error) {
    console.error("[adtrack] insert error:", error.message);
    return res.status(500).json({ error: "failed to record event" });
  }

  return res.json({ ok: true, event_key, platform_inferred });
});

/**
 * GET /api/adtrack/summary?days=7
 * Admin-only: returns conversion counts by platform and event type.
 */
router.get("/adtrack/summary", async (req, res) => {
  if (!isConfigured) return res.status(503).json({ error: "not configured" });

  // Basic auth: only ADMIN_EMAILS can access
  const auth = req.headers.authorization || "";
  if (!auth) return res.status(401).json({ error: "unauthorized" });

  const days = Math.min(parseInt(req.query.days || "7"), 90);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("ad_conversion_events")
    .select("event_type, platform_inferred, occurred_at")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Aggregate
  const summary = {};
  for (const row of data || []) {
    const key = `${row.platform_inferred}|${row.event_type}`;
    summary[key] = (summary[key] || 0) + 1;
  }

  const rows = Object.entries(summary).map(([key, count]) => {
    const [platform, event_type] = key.split("|");
    return { platform, event_type, count };
  }).sort((a, b) => b.count - a.count);

  return res.json({ days, total: data?.length || 0, by_platform_and_event: rows });
});

module.exports = router;
