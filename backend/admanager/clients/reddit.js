// ROOK Ad Manager — Reddit Ads API client
//
// Uses the Reddit Ads API v3. Requires:
//   REDDIT_ADS_CLIENT_ID
//   REDDIT_ADS_CLIENT_SECRET
//   REDDIT_ADS_REFRESH_TOKEN   (from OAuth2 authorization_code flow)
//   REDDIT_ADS_ACCOUNT_ID      (a2_XXXXX format)
//
// Reddit Ads API docs: https://ads-api.reddit.com/docs/v3/
// Rate limit: 60 requests/minute per token.

const BASE_URL = "https://ads-api.reddit.com/api/v3";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REQUEST_TIMEOUT_MS = 30_000;
const { calendarRange } = require("../reportingPeriod");

function getCredentials() {
  const required = ["REDDIT_ADS_CLIENT_ID", "REDDIT_ADS_CLIENT_SECRET", "REDDIT_ADS_REFRESH_TOKEN", "REDDIT_ADS_ACCOUNT_ID"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Reddit Ads: missing env vars: ${missing.join(", ")}`);
  return {
    clientId: process.env.REDDIT_ADS_CLIENT_ID,
    clientSecret: process.env.REDDIT_ADS_CLIENT_SECRET,
    refreshToken: process.env.REDDIT_ADS_REFRESH_TOKEN,
    accountId: process.env.REDDIT_ADS_ACCOUNT_ID,
  };
}

let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken;
  const creds = getCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "ROOK:AdManager:1.0 (by /u/rookcareers)",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Reddit token refresh failed: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Reddit token error: ${data.error}`);
    _cachedToken = data.access_token;
    _tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return _cachedToken;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeResponse(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const REDACTED = ["access_token", "refresh_token", "client_secret"];
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACTED.includes(k) ? "[REDACTED]" : (typeof v === "object" && v !== null ? sanitizeResponse(v) : v);
  }
  return out;
}

async function redditGet(path, params = {}) {
  const token = await getAccessToken();
  const qs = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const url = `${BASE_URL}${path}${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ROOK:AdManager:1.0 (by /u/rookcareers)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Reddit GET ${path} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function redditPatch(path, body = {}) {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ROOK:AdManager:1.0 (by /u/rookcareers)",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Reddit PATCH ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all campaigns for the account.
 * v3: GET /ad_accounts/{ad_account_id}/campaigns
 */
async function fetchCampaigns() {
  const creds = getCredentials();
  const data = await redditGet(`/ad_accounts/${creds.accountId}/campaigns`);
  return (data.data || []).map(sanitizeResponse);
}

/**
 * Fetch campaign performance stats for a given date range.
 * v3: POST /ad_accounts/{ad_account_id}/reports with JSON body
 */
async function fetchCampaignStats(campaignId, startDate, endDate) {
  const creds = getCredentials();
  const token = await getAccessToken();
  const url = `${BASE_URL}/ad_accounts/${creds.accountId}/reports`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "ROOK:AdManager:1.0 (by /u/rookcareers)",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        data: {
          starts_at:  startDate + "T00:00:00Z",
          ends_at:    endDate   + "T23:00:00Z",
          fields:     ["IMPRESSIONS", "CLICKS", "SPEND"],
          breakdowns: ["DATE"],
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Reddit reports POST failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return sanitizeResponse(await res.json());
  } catch (err) {
    console.error(`Reddit stats error for ${campaignId}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all campaigns with today's performance, normalized.
 */
async function fetchCampaignPerformance(period = "today") {
  const creds = getCredentials();
  // Reddit's report defaults to UTC; use the same UTC calendar for its boundaries.
  const range = calendarRange(period, "UTC");
  const campaignsData = await redditGet(`/ad_accounts/${creds.accountId}/campaigns`);
  const campaigns = campaignsData.data || [];
  if (!campaigns.length) return [];
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/ad_accounts/${creds.accountId}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "ROOK:AdManager:1.0 (by /u/rookcareers)", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ data: {
      starts_at: range.since + "T00:00:00Z",
      ends_at: range.until + "T23:59:59Z",
      fields: ["IMPRESSIONS", "CLICKS", "SPEND"],
      breakdowns: ["CAMPAIGN_ID"],
    } }),
  });
  if (!res.ok) throw new Error(`Reddit campaign report failed (${res.status})`);
  const report = await res.json();
  if (!Array.isArray(report?.data?.metrics)) throw new Error("Reddit campaign report missing metrics");
  const byId = new Map();
  for (const row of report.data.metrics) {
    const id = String(row.campaign_id || row.campaignId || "");
    if (!id) throw new Error("Reddit campaign report missing campaign ID breakdown");
    const current = byId.get(id) || { spend_cents: 0, impressions: 0, clicks: 0 };
    current.spend_cents += Math.round(Number(row.spend || 0) / 10_000);
    current.impressions += Number(row.impressions || 0);
    current.clicks += Number(row.clicks || 0);
    byId.set(id, current);
  }
  return campaigns.map(c => ({
    platform: "reddit", external_campaign_id: c.id, campaign_name: c.name || "",
    status: c.status || "", effective_status: c.effective_status || c.status || "",
    objective: c.objective || "", start_date: c.start_date || null, end_date: c.end_date || null,
    daily_budget_cents: c.daily_budget_cents ? Math.round(c.daily_budget_cents / 100)
      : c.goal_value ? Math.round(c.goal_value / 10_000) : null,
    total_budget_cents: c.total_budget_cents || null,
    ...(byId.get(String(c.id)) || { spend_cents: 0, impressions: 0, clicks: 0 }),
    conversions: null, conversion_label: "Unavailable from Reddit report",
    reporting_timezone: "UTC", _raw: sanitizeResponse(c),
  }));
}

/**
 * Update campaign daily budget.
 * v3: PATCH /ad_accounts/{ad_account_id}/campaigns/{campaign_id}
 */
async function setCampaignBudget(campaignId, newDailyBudgetCents) {
  const creds = getCredentials();
  const result = await redditPatch(
    `/ad_accounts/${creds.accountId}/campaigns/${campaignId}`,
    { daily_budget_cents: newDailyBudgetCents }
  );
  return sanitizeResponse(result);
}

/**
 * Pause or activate a campaign.
 * v3: PATCH /ad_accounts/{ad_account_id}/campaigns/{campaign_id}
 * @param {'PAUSED'|'ACTIVE'} newStatus
 */
async function setCampaignStatus(campaignId, newStatus) {
  const creds = getCredentials();
  const result = await redditPatch(
    `/ad_accounts/${creds.accountId}/campaigns/${campaignId}`,
    { status: newStatus }
  );
  return sanitizeResponse(result);
}

/**
 * Test connection.
 * v3: GET /ad_accounts/{ad_account_id}
 */
async function testConnection() {
  try {
    const creds = getCredentials();
    const data = await redditGet(`/ad_accounts/${creds.accountId}`);
    return { ok: true, account_name: data?.data?.name || data?.name || creds.accountId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  fetchCampaignPerformance,
  fetchCampaignStats,
  setCampaignBudget,
  setCampaignStatus,
  testConnection,
  sanitizeResponse,
};
