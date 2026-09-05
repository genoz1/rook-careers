// Social posting automation — foundations only (candidate feed, final
// validation). The Buffer publishing worker itself is explicitly out
// of scope for this pass; nothing here talks to Buffer, Facebook, or
// LinkedIn.
//
// Setup required: SOCIAL_AUTOMATION_TOKEN and SOCIAL_SPACING_HMAC_SECRET
// in your .env — both required for this router to function at all.
// Generate each with: openssl rand -hex 32
// SOCIAL_AUTOMATION_TOKEN must be a DIFFERENT value than BUFFER_API_KEY
// — they authenticate different things (this app's own API vs. a
// third-party service), and reusing one secret for both means a leak
// of either credential compromises both systems at once. Neither
// value should ever be printed, requested, or logged by this code or
// by anyone working on it — set them directly in your hosting
// platform's environment variable settings.

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  evaluateEligibility,
  scoreAndSortCandidates,
  buildCandidateResponse,
  computeJobFingerprint,
  buildBrandedTermList,
} = require("../socialAutomation");

const router = express.Router();

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// A second, anon-key client used SPECIFICALLY for the public_url_valid
// proof in the validate endpoint below — deliberately the same
// credential level the real /jobs/:id route itself queries with
// (backend/routes/publicPages.js), so that check is subject to the
// exact same RLS policy as the real public page, not an approximation
// of it running under elevated backend privileges.
const supabaseAnonForProof = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!supabaseAdmin || !supabaseAnonForProof || !process.env.SOCIAL_AUTOMATION_TOKEN || !process.env.SOCIAL_SPACING_HMAC_SECRET) {
    return res.status(503).json({ error: "Social automation isn't fully configured on this server yet." });
  }
  next();
}

function requireAutomationAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = process.env.SOCIAL_AUTOMATION_TOKEN || "";

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const authorized = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!authorized) {
    console.warn(`[social-automation] unauthorized request to ${req.method} ${req.path} from ${req.ip}`); // never logs the token itself
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitState = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const entry = rateLimitState.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(key, { count: 1, windowStart: now });
    return next();
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

const FRESHNESS_WINDOW_DAYS = Number(process.env.SOCIAL_FRESHNESS_WINDOW_DAYS) || 3;
const EMPLOYER_SPACING_DAYS = Number(process.env.SOCIAL_EMPLOYER_SPACING_DAYS) || 14;
const CATEGORY_VARIATION_LOOKBACK = Number(process.env.SOCIAL_CATEGORY_VARIATION_LOOKBACK) || 4; // last N posts

// SOCIAL_BRANDED_TERMS (comma-separated) covers product/program names —
// there is no table anywhere in the app for these, so this list must
// be maintained manually as real branded terms are identified. The
// employers table's own company_name column, by contrast, IS an
// authoritative, already-maintained source, fetched fresh below on
// every candidates request rather than hardcoded or cached indefinitely
// stale.
const ADDITIONAL_BRANDED_TERMS = (process.env.SOCIAL_BRANDED_TERMS || "").split(",").map((s) => s.trim()).filter(Boolean);

const JOB_COLUMNS = "id, employer_id, source_job_id, title_original, location_raw, territory, ai_analysis, compensation_text, salary_min, salary_max, employment_type, remote_status, experience_min_years, company_name, status, moderation_status, social_eligible, expires_at, last_seen_at";

async function fetchBrandedTerms() {
  const { data, error } = await supabaseAdmin.from("employers").select("company_name");
  if (error) {
    console.error(`[social-automation] could not fetch employer names for branded-term list: ${error.message}`);
    return buildBrandedTermList([], ADDITIONAL_BRANDED_TERMS); // degrade to the manual list rather than fail the whole request
  }
  return buildBrandedTermList((data || []).map((e) => e.company_name), ADDITIONAL_BRANDED_TERMS);
}

// GET /api/automation/social-jobs/candidates?slot=am|pm&limit=50
router.get("/automation/social-jobs/candidates", requireConfig, rateLimit, requireAutomationAuth, async (req, res) => {
  try {
    const slot = req.query.slot === "pm" ? "pm" : "am";
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const today = new Date().toISOString().slice(0, 10);

    const brandedTerms = await fetchBrandedTerms();

    const { data: rawJobs, error } = await supabaseAdmin
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .eq("social_eligible", true)
      .order("last_seen_at", { ascending: false })
      .limit(1000);
    if (error) throw error;

    const eligibleJobs = (rawJobs || []).filter((job) =>
      evaluateEligibility(job, { freshnessWindowDays: FRESHNESS_WINDOW_DAYS, brandedTerms }).eligible
    );

    // Permanent history, fetched once and consulted for THREE separate
    // purposes below: never-featured preference, employer spacing, and
    // category variation — one source of truth for all three, not
    // three separate queries that could disagree with each other.
    const { data: fbHistory, error: fbHistoryError } = await supabaseAdmin
      .from("social_post_history")
      .select("job_id, job_fingerprint, employer_spacing_key, category, run_key, scheduled_for")
      .in("facebook_status", ["scheduled", "sent"])
      .order("scheduled_for", { ascending: false })
      .limit(5000);
    if (fbHistoryError) throw fbHistoryError;
    const { data: liHistory, error: liHistoryError } = await supabaseAdmin
      .from("social_post_history")
      .select("job_id, job_fingerprint, employer_spacing_key, category, scheduled_for")
      .in("linkedin_status", ["scheduled", "sent"])
      .order("scheduled_for", { ascending: false })
      .limit(5000);
    if (liHistoryError) throw liHistoryError;

    const allHistory = [...(fbHistory || []), ...(liHistory || [])];

    // Permanent duplicate prevention keyed on the deletion-proof
    // fingerprint, not the mutable jobs.id — see schema.sql's
    // job_fingerprint documentation for why job_id alone isn't enough.
    const previouslyFeaturedFingerprints = new Set(allHistory.map((r) => r.job_fingerprint).filter(Boolean));

    const spacingCutoff = new Date(Date.now() - EMPLOYER_SPACING_DAYS * 24 * 60 * 60 * 1000);
    const recentEmployerSpacingKeys = new Set(
      allHistory.filter((r) => r.employer_spacing_key && new Date(r.scheduled_for) >= spacingCutoff).map((r) => r.employer_spacing_key)
    );

    // Category variation: the most recent N posts' categories,
    // consulted so the ranking can strongly prefer something different
    // from what was JUST featured, not a global all-time frequency
    // count (which would over-penalize a category that's simply common
    // among genuinely eligible jobs).
    const recentCategories = allHistory
      .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for))
      .slice(0, CATEGORY_VARIATION_LOOKBACK)
      .map((r) => r.category)
      .filter(Boolean);

    // Real fingerprint-based previously-featured check, replacing the
    // earlier job_id-based one that would have missed a
    // deleted-and-reimported duplicate entirely.
    const previouslyFeaturedJobIds = new Set(
      eligibleJobs
        .filter((job) => previouslyFeaturedFingerprints.has(computeJobFingerprint(job.employer_id, job.source_job_id, process.env.SOCIAL_SPACING_HMAC_SECRET)))
        .map((job) => job.id)
    );

    let excludedJobIds = new Set();
    if (slot === "pm") {
      const { data: amRow } = await supabaseAdmin
        .from("social_post_history")
        .select("job_id")
        .eq("run_key", `${today}-AM`)
        .maybeSingle();
      if (amRow?.job_id) excludedJobIds = new Set([amRow.job_id]);
    }

    const ranked = scoreAndSortCandidates(eligibleJobs, {
      previouslyFeaturedJobIds,
      excludedJobIds,
      recentEmployerSpacingKeys,
      recentCategories,
      spacingSecret: process.env.SOCIAL_SPACING_HMAC_SECRET,
    });

    const candidates = ranked.slice(0, limit).map((job) => buildCandidateResponse(job, process.env.SOCIAL_SPACING_HMAC_SECRET));
    res.json({ candidates });
  } catch (err) {
    console.error(`[social-automation] candidates endpoint failed: ${err.message}`);
    res.status(500).json({ error: "Could not load social job candidates right now." });
  }
});

// GET /api/automation/social-jobs/:job_id/validate?content_version=...
router.get("/automation/social-jobs/:job_id/validate", requireConfig, rateLimit, requireAutomationAuth, async (req, res) => {
  try {
    const { data: job, error } = await supabaseAdmin
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("id", req.params.job_id)
      .maybeSingle();
    if (error) throw error;

    if (!job) {
      return res.json({
        job_id: req.params.job_id, eligible: false, active: false, public_url_valid: false,
        last_verified_at: null, expires_at: null, content_version: null, reason_codes: ["not_found"],
      });
    }

    const brandedTerms = await fetchBrandedTerms();
    const result = evaluateEligibility(job, {
      freshnessWindowDays: FRESHNESS_WINDOW_DAYS,
      expectedContentVersion: req.query.content_version || null,
      brandedTerms,
    });

    // The actual proof for public_url_valid: re-run the SAME query the
    // real /jobs/:id route runs, through the SAME anon-key client
    // subject to the SAME RLS policy — if a row comes back, the public
    // route can genuinely serve this job right now; if not, it can't,
    // regardless of what the in-memory status/moderation_status fields
    // on the already-fetched row above say. This is the one place the
    // two are allowed to disagree, and this query wins.
    const { data: publicRow } = await supabaseAnonForProof
      .from("jobs")
      .select("id")
      .eq("id", job.id)
      .eq("status", "active")
      .maybeSingle();
    const provenPublicUrlValid = Boolean(publicRow);
    if (!provenPublicUrlValid && !result.reason_codes.includes("invalid_public_url")) {
      result.reason_codes.push("invalid_public_url");
    }
    result.public_url_valid = provenPublicUrlValid;
    result.eligible = result.eligible && provenPublicUrlValid;

    res.json({ job_id: job.id, ...result });
  } catch (err) {
    console.error(`[social-automation] validate endpoint failed: ${err.message}`);
    res.status(500).json({ error: "Could not validate this job right now." });
  }
});

module.exports = router;
