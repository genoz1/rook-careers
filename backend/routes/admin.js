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

// Real bug this fixes: the /admin/employers routes below only ever
// checked requireAuth — meaning any signed-in account, not just an
// actual admin, could add or list managed employers. Same fix as the
// identical gap found in recruiterPostings.js's admin routes.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

async function requireAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  if (!email || !ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({ error: "Not authorized." });
  }
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
router.post("/admin/employers", requireConfig, requireAuth, requireAdmin, async (req, res) => {
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
  } else if (ats_type_override === "oraclehcm") {
    // Oracle HCM needs both a domain AND a siteNumber (see the /sites/
    // {siteNumber}/... path segment in the employer's real careers URL)
    // — a bare hostname isn't enough to build working API calls. Expect
    // careers_url to be pasted as the FULL careers URL including that
    // /sites/{siteNumber}/ segment, e.g.
    // https://hdox.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs
    try {
      const parsed = new URL(careers_url.trim());
      const siteMatch = parsed.pathname.match(/\/sites\/([^/]+)/i);
      if (!siteMatch) {
        return res.status(400).json({
          error:
            "For Oracle HCM, paste the full careers URL including the /sites/{siteNumber}/ segment, " +
            "e.g. https://hdox.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs",
        });
      }
      detected = { ats_type: "oraclehcm", ats_identifier: `${parsed.hostname}|${siteMatch[1]}` };
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
router.get("/admin/employers", requireConfig, requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("employers")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/admin/admanager/import?token=...
// Imports all live campaigns into ad_campaign_controls.
// ON CONFLICT DO NOTHING — never overwrites existing rows.
// Sets desired_state from actual platform status. approved_for_automation=false always.
router.post("/admin/admanager/import", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) return res.status(401).json({ error: "unauthorized" });

  const enabled = (process.env.AD_ENABLED_PLATFORMS || "").split(",").map(p => p.trim()).filter(Boolean);
  const imported = [], skipped = [], errors = [];

  const activeStatuses = ["active","enabled","ACTIVE","ENABLED"];

  const importCampaigns = async (platformName, campaigns) => {
    for (const c of campaigns) {
      const desired = activeStatuses.includes(c.status || c.effective_status) ? "active" : "paused";
      const row = {
        platform: platformName,
        external_campaign_id: String(c.external_campaign_id),
        campaign_name: c.campaign_name || "",
        desired_state: desired,
        approved_for_automation: false,
        destination_url: "https://rookcareers.com/rook-onboarding-v4.html",
        min_daily_budget_cents: 200,   // $2/day minimum per campaign
        max_daily_budget_cents: 1500,  // $15/day max per campaign (well within $30 total)
        notes: `Auto-imported ${new Date().toISOString().slice(0,10)}. Budget: ${c.budget_cents ? "$"+(c.budget_cents/100).toFixed(2)+"/day" : "unknown"}`,
      };
      const { error } = await supabaseAdmin.from("ad_campaign_controls").insert(row);
      if (error) {
        if (error.code === "23505") skipped.push({ platform: platformName, id: c.external_campaign_id, name: c.campaign_name });
        else errors.push({ platform: platformName, id: c.external_campaign_id, error: error.message });
      } else {
        imported.push({ platform: platformName, id: c.external_campaign_id, name: c.campaign_name, desired_state: desired });
      }
    }
  };

  try {
    if (enabled.includes("meta") && process.env.META_ADS_ACCESS_TOKEN) {
      const camps = await require("../admanager/clients/meta").fetchCampaignPerformance("today");
      await importCampaigns("meta", camps);
    }
    if (enabled.includes("google") && process.env.GOOGLE_ADS_CUSTOMER_ID) {
      const camps = await require("../admanager/clients/google").fetchCampaignPerformance();
      await importCampaigns("google", camps);
    }
    if (enabled.includes("reddit") && process.env.REDDIT_ADS_ACCOUNT_ID) {
      const camps = await require("../admanager/clients/reddit").fetchCampaignPerformance();
      await importCampaigns("reddit", camps);
    }
  } catch(err) {
    errors.push({ platform: "unknown", error: err.message });
  }

  return res.json({ imported, skipped, errors });
});

// GET /api/admin/admanager/controls?token=...
router.get("/admin/admanager/controls", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) return res.status(401).json({ error: "unauthorized" });
  const { data, error } = await supabaseAdmin.from("ad_campaign_controls").select("*").order("platform").order("campaign_name");
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ controls: data || [] });
});

// PATCH /api/admin/admanager/controls/:id?token=...
// Only allows safe fields — never enables write mode or changes platform credentials.
router.patch("/admin/admanager/controls/:id", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) return res.status(401).json({ error: "unauthorized" });
  const allowed = ["campaign_name","desired_state","approved_for_automation","min_daily_budget_cents","max_daily_budget_cents","destination_url","notes"];
  const update = {};
  for (const k of allowed) { if (req.body[k] !== undefined) update[k] = req.body[k]; }
  update.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("ad_campaign_controls").update(update).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ control: data });
});

// GET /api/admin/admanager/dryrun?token=...
// Runs the full policy engine against today's live data and returns proposed actions.
router.get("/admin/admanager/dryrun", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) return res.status(401).json({ error: "unauthorized" });

  const policy = require("../admanager/policy");
  const enabled = (process.env.AD_ENABLED_PLATFORMS || "").split(",").map(p => p.trim()).filter(Boolean);
  const results = [];

  const { data: controls } = await supabaseAdmin.from("ad_campaign_controls").select("*");
  const controlMap = new Map((controls||[]).map(c => [`${c.platform}:${c.external_campaign_id}`, c]));

  const evalPlatform = async (name, fetchFn) => {
    try {
      const campaigns = await fetchFn();
      for (const c of campaigns) {
        const ctrl = controlMap.get(`${name}:${c.external_campaign_id}`);
        const alerts = policy.evaluateAlerts(c, ctrl || { desired_state: "active", destination_url: "https://rookcareers.com/rook-onboarding-v4.html" });
        const actions = ctrl ? policy.evaluateBudgetPolicy(c, ctrl) : [{ action_type: "skip_no_controls", reason: "No controls row — import campaigns first" }];
        results.push({ platform: name, campaign_id: c.external_campaign_id, campaign_name: c.campaign_name,
          status: c.status, spend_cents: c.spend_cents, impressions: c.impressions, clicks: c.clicks,
          conversions: c.conversions, budget_cents: c.budget_cents,
          has_controls: !!ctrl, approved_for_automation: ctrl?.approved_for_automation || false,
          alerts, actions });
      }
    } catch(err) {
      results.push({ platform: name, error: err.message });
    }
  };

  if (enabled.includes("meta") && process.env.META_ADS_ACCESS_TOKEN)
    await evalPlatform("meta", () => require("../admanager/clients/meta").fetchCampaignPerformance("today"));
  if (enabled.includes("google") && process.env.GOOGLE_ADS_CUSTOMER_ID)
    await evalPlatform("google", () => require("../admanager/clients/google").fetchCampaignPerformance());
  if (enabled.includes("reddit") && process.env.REDDIT_ADS_ACCOUNT_ID)
    await evalPlatform("reddit", () => require("../admanager/clients/reddit").fetchCampaignPerformance());

  const config = policy.CONFIG;
  return res.json({ dry_run: true, mode: process.env.AD_MANAGER_MODE || "off", config, results, generated_at: new Date().toISOString() });
});

module.exports = router;

// Returns live campaign data from all configured platforms for the dashboard.
router.get("/admin/admanager/dashboard", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const enabled = (process.env.AD_ENABLED_PLATFORMS || "").split(",").map(p => p.trim()).filter(Boolean);
  const mode = process.env.AD_MANAGER_MODE || "off";
  const platforms = {};

  const fetchPlatform = async (name, fetchFn) => {
    try {
      platforms[name] = { ok: true, campaigns: await fetchFn(), error: null };
    } catch (err) {
      platforms[name] = { ok: false, campaigns: [], error: err.message };
    }
  };

  await Promise.all([
    enabled.includes("meta") && process.env.META_ADS_ACCESS_TOKEN
      ? fetchPlatform("meta", () => require("../admanager/clients/meta").fetchCampaignPerformance("today"))
      : Promise.resolve(),
    enabled.includes("google") && process.env.GOOGLE_ADS_CUSTOMER_ID
      ? fetchPlatform("google", () => require("../admanager/clients/google").fetchCampaignPerformance())
      : Promise.resolve(),
    enabled.includes("reddit") && process.env.REDDIT_ADS_ACCOUNT_ID
      ? fetchPlatform("reddit", () => require("../admanager/clients/reddit").fetchCampaignPerformance())
      : Promise.resolve(),
  ]);

  // Also pull recent snapshots from DB
  let snapshots = [];
  try {
    const { data } = await supabaseAdmin
      .from("ad_performance_snapshots")
      .select("*")
      .gte("snapshot_date", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .order("snapshot_date", { ascending: false })
      .limit(200);
    snapshots = data || [];
  } catch (_) {}

  return res.json({ mode, enabled_platforms: enabled, platforms, snapshots, fetched_at: new Date().toISOString() });
});

module.exports = router;

// ── Ad Manager connection test ────────────────────────────────────────────
// GET /api/admin/admanager/test?token=YOUR_AD_MANAGER_TEST_TOKEN
// Tests connectivity to each configured ad platform without making any changes.
router.get("/admin/admanager/test", async (req, res) => {
  const expectedToken = process.env.AD_MANAGER_TEST_TOKEN;
  if (!expectedToken || req.query.token !== expectedToken) {
    return res.status(401).json({ error: "unauthorized — provide ?token=AD_MANAGER_TEST_TOKEN" });
  }
  const results = {};
  const enabled = (process.env.AD_ENABLED_PLATFORMS || "").split(",").map(p => p.trim()).filter(Boolean);
  const mode = process.env.AD_MANAGER_MODE || "off";

  if (mode === "off") {
    return res.json({ mode, message: "AD_MANAGER_MODE is 'off' — set to 'dry-run' to test connections" });
  }

  if (enabled.includes("meta") && process.env.META_ADS_ACCESS_TOKEN && process.env.META_ADS_ACCOUNT_ID) {
    try {
      const meta = require("../admanager/clients/meta");
      results.meta = await meta.testConnection();
    } catch (err) {
      results.meta = { ok: false, error: err.message };
    }
  } else if (enabled.includes("meta")) {
    results.meta = { ok: false, error: "META_ADS_ACCESS_TOKEN or META_ADS_ACCOUNT_ID not set" };
  }

  if (enabled.includes("google") && process.env.GOOGLE_ADS_CUSTOMER_ID) {
    try {
      const google = require("../admanager/clients/google");
      results.google = await google.testConnection();
    } catch (err) {
      results.google = { ok: false, error: err.message };
    }
  } else if (enabled.includes("google")) {
    results.google = { ok: false, error: "GOOGLE_ADS_CUSTOMER_ID not set" };
  }

  if (enabled.includes("reddit") && process.env.REDDIT_ADS_ACCOUNT_ID) {
    try {
      const reddit = require("../admanager/clients/reddit");
      results.reddit = await reddit.testConnection();
    } catch (err) {
      results.reddit = { ok: false, error: err.message };
    }
  } else if (enabled.includes("reddit")) {
    results.reddit = { ok: false, error: "REDDIT_ADS_ACCOUNT_ID not set" };
  }

  return res.json({ mode, enabled_platforms: enabled, connections: results });
});
