// ROOK Ad Manager — Meta (Facebook) Marketing API client
//
// Uses the Meta Marketing API v19.0. Requires:
//   META_ADS_ACCESS_TOKEN     (long-lived System User token)
//   META_ADS_ACCOUNT_ID      (act_XXXXXXXXXX format, or just the number)
//   META_ADS_APP_ID          (optional, for token inspection)
//
// Rate limits: Standard access allows ~200 calls/hour per user token.
// This client does not paginate — campaigns list assumed < 200 rows.

const META_API_VERSION = "v19.0";
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 30_000;

function getCredentials() {
  const required = ["META_ADS_ACCESS_TOKEN", "META_ADS_ACCOUNT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Meta Ads: missing env vars: ${missing.join(", ")}`);
  const accountId = process.env.META_ADS_ACCOUNT_ID.startsWith("act_")
    ? process.env.META_ADS_ACCOUNT_ID
    : `act_${process.env.META_ADS_ACCOUNT_ID}`;
  return {
    accessToken: process.env.META_ADS_ACCESS_TOKEN,
    accountId,
  };
}

function sanitizeResponse(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const REDACTED_KEYS = ["access_token", "client_secret"];
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_KEYS.includes(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = sanitizeResponse(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function metaGet(path, params = {}) {
  const creds = getCredentials();
  const qs = new URLSearchParams({ ...params, access_token: creds.accessToken }).toString();
  const url = `${BASE_URL}${path}?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Meta GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`Meta API error: ${data.error.message} (code ${data.error.code})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function metaPost(path, body = {}) {
  const creds = getCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: creds.accessToken }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Meta POST ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`Meta API error: ${data.error.message} (code ${data.error.code})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const META_CAMPAIGN_FIELDS = [
  "id", "name", "status", "effective_status",
  "objective", "start_time", "stop_time",
  "daily_budget", "lifetime_budget",
  "budget_remaining",
  "insights.fields(spend,impressions,clicks,actions,cost_per_action_type)",
].join(",");

/**
 * Fetch all campaigns with today's performance.
 */
async function fetchCampaignPerformance(datePreset = "today") {
  const creds = getCredentials();
  const data = await metaGet(`/${creds.accountId}/campaigns`, {
    fields: META_CAMPAIGN_FIELDS,
    date_preset: datePreset,
    limit: "200",
  });

  const campaigns = data.data || [];
  return campaigns.map((c) => {
    const insights = c.insights?.data?.[0] || {};
    const actions = insights.actions || [];
    const getAction = (actionType) =>
      Number(actions.find((a) => a.action_type === actionType)?.value || 0);

    const spendCents = Math.round(parseFloat(insights.spend || "0") * 100);
    const dailyBudgetCents = c.daily_budget ? Math.round(parseInt(c.daily_budget) / 10) : null;
    const lifetimeBudgetCents = c.lifetime_budget ? Math.round(parseInt(c.lifetime_budget) / 10) : null;

    return {
      platform: "meta",
      external_campaign_id: c.id,
      campaign_name: c.name || "",
      status: c.status || "",
      effective_status: c.effective_status || "",
      objective: c.objective || "",
      start_time: c.start_time || null,
      stop_time: c.stop_time || null,
      daily_budget_cents: dailyBudgetCents,
      lifetime_budget_cents: lifetimeBudgetCents,
      budget_remaining_cents: c.budget_remaining
        ? Math.round(parseInt(c.budget_remaining) / 10)
        : null,
      spend_cents: spendCents,
      impressions: Number(insights.impressions || 0),
      clicks: Number(insights.clicks || 0),
      // Map standard conversion actions
      conversions_landing: getAction("landing_page_view"),
      conversions_lead: getAction("lead"),
      conversions_complete_registration: getAction("complete_registration"),
      conversions_purchase: getAction("purchase"),
      _raw: sanitizeResponse(c),
    };
  });
}

/**
 * Update campaign daily budget (in cents).
 * Meta API takes amounts in cents (not micros).
 */
async function setCampaignBudget(campaignId, newDailyBudgetCents) {
  // Meta accepts daily_budget in cents (integer string)
  const result = await metaPost(`/${campaignId}`, {
    daily_budget: String(newDailyBudgetCents),
  });
  return sanitizeResponse(result);
}

/**
 * Pause or enable a campaign.
 * @param {string} campaignId
 * @param {'PAUSED'|'ACTIVE'} newStatus
 */
async function setCampaignStatus(campaignId, newStatus) {
  const result = await metaPost(`/${campaignId}`, { status: newStatus });
  return sanitizeResponse(result);
}

/**
 * Fetch ads with policy issues for a campaign.
 */
async function fetchRejectedAds(campaignId) {
  try {
    const data = await metaGet(`/${campaignId}/ads`, {
      fields: "id,name,status,effective_status,review_feedback",
      filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["DISAPPROVED", "CAMPAIGN_PAUSED"] }]),
    });
    return (data.data || []).map(sanitizeResponse);
  } catch (_) {
    return [];
  }
}

/**
 * Inspect token expiry. Returns days until expiration or null if unknown.
 */
async function getTokenExpiry() {
  const creds = getCredentials();
  try {
    const data = await metaGet("/debug_token", {
      input_token: creds.accessToken,
      // Needs an app token — skip quietly if not configured
    });
    const expiry = data.data?.expires_at;
    if (!expiry) return null;
    const daysLeft = Math.round((expiry * 1000 - Date.now()) / 86_400_000);
    return { expires_at: new Date(expiry * 1000).toISOString(), days_left: daysLeft };
  } catch (_) {
    return null;
  }
}

async function testConnection() {
  try {
    const creds = getCredentials();
    const data = await metaGet(`/${creds.accountId}`, { fields: "id,name" });
    return { ok: true, account_name: data.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  fetchCampaignPerformance,
  setCampaignBudget,
  setCampaignStatus,
  fetchRejectedAds,
  getTokenExpiry,
  testConnection,
  sanitizeResponse,
};
