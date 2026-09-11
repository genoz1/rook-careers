// ROOK Ad Manager — Reddit Ads API client
//
// Uses the Reddit Ads API v2. Requires:
//   REDDIT_ADS_CLIENT_ID
//   REDDIT_ADS_CLIENT_SECRET
//   REDDIT_ADS_REFRESH_TOKEN   (from OAuth2 authorization_code flow)
//   REDDIT_ADS_ACCOUNT_ID      (t2_XXXXX format or just the ID)
//
// Reddit Ads API docs: https://ads-api.reddit.com/docs/v2/
// Rate limit: 60 requests/minute per token.

const BASE_URL = "https://ads-api.reddit.com/api/v2.0";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REQUEST_TIMEOUT_MS = 30_000;

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
        "User-Agent": "ROOK-AdManager/1.0",
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
        "User-Agent": "ROOK-AdManager/1.0",
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
        "User-Agent": "ROOK-AdManager/1.0",
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
 */
async function fetchCampaigns() {
  const creds = getCredentials();
  const data = await redditGet(`/accounts/${creds.accountId}/campaigns`);
  return (data.data || []).map(sanitizeResponse);
}

/**
 * Fetch campaign performance stats for a given date range.
 * @param {string} campaignId
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
async function fetchCampaignStats(campaignId, startDate, endDate) {
  const creds = getCredentials();
  try {
    const data = await redditGet(`/accounts/${creds.accountId}/campaigns/${campaignId}/stats`, {
      start_date: startDate,
      end_date: endDate,
      interval: "day",
    });
    return sanitizeResponse(data);
  } catch (_) {
    return null;
  }
}

/**
 * Fetch all campaigns with today's performance, normalized.
 */
async function fetchCampaignPerformance() {
  const creds = getCredentials();
  const today = new Date().toISOString().slice(0, 10);

  const campaignsData = await redditGet(`/accounts/${creds.accountId}/campaigns`);
  const campaigns = campaignsData.data || [];

  const results = await Promise.all(campaigns.map(async (c) => {
    let stats = null;
    try {
      stats = await fetchCampaignStats(c.id, today, today);
    } catch (_) {}

    const statsData = stats?.data?.[0] || {};
    const spendCents = statsData.spend ? Math.round(parseFloat(statsData.spend) * 100) : 0;

    return {
      platform: "reddit",
      external_campaign_id: c.id,
      campaign_name: c.name || "",
      status: c.status || "",
      effective_status: c.effective_status || c.status || "",
      objective: c.objective || "",
      start_date: c.start_date || null,
      end_date: c.end_date || null,
      daily_budget_cents: c.daily_budget_cents || (c.total_budget_cents ? null : null),
      total_budget_cents: c.total_budget_cents || null,
      spend_cents: spendCents,
      impressions: Number(statsData.impressions || 0),
      clicks: Number(statsData.clicks || 0),
      conversions: Number(statsData.conversions || 0),
      _raw: sanitizeResponse(c),
    };
  }));

  return results;
}

/**
 * Update campaign daily budget.
 * Reddit API uses cents for budget values.
 */
async function setCampaignBudget(campaignId, newDailyBudgetCents) {
  const creds = getCredentials();
  const result = await redditPatch(
    `/accounts/${creds.accountId}/campaigns/${campaignId}`,
    { daily_budget_cents: newDailyBudgetCents }
  );
  return sanitizeResponse(result);
}

/**
 * Pause or activate a campaign.
 * @param {'PAUSED'|'ACTIVE'} newStatus
 */
async function setCampaignStatus(campaignId, newStatus) {
  const creds = getCredentials();
  const result = await redditPatch(
    `/accounts/${creds.accountId}/campaigns/${campaignId}`,
    { status: newStatus }
  );
  return sanitizeResponse(result);
}

async function testConnection() {
  try {
    const creds = getCredentials();
    const data = await redditGet(`/accounts/${creds.accountId}`);
    return { ok: true, account_name: data?.data?.name || creds.accountId };
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
