// ROOK Ad Manager — Google Ads API client
//
// Uses the Google Ads REST API (v17). Requires:
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_CLIENT_ID
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_CUSTOMER_ID   (10-digit, no dashes)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  (MCC account if applicable, else same as CUSTOMER_ID)
//
// Never logs secrets. All credential access goes through getCredentials().

const GOOGLE_ADS_API_VERSION = "v17";
const BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 30_000;

function getCredentials() {
  const required = [
    "GOOGLE_ADS_DEVELOPER_TOKEN",
    "GOOGLE_ADS_CLIENT_ID",
    "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN",
    "GOOGLE_ADS_CUSTOMER_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Google Ads: missing env vars: ${missing.join(", ")}`);
  }
  return {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, ""),
    loginCustomerId: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, ""),
  };
}

// Access token cache (in-memory, refreshed before expiry)
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken;
  const creds = getCredentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
    const data = await res.json();
    _cachedToken = data.access_token;
    _tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return _cachedToken;
  } finally {
    clearTimeout(timer);
  }
}

async function googleAdsQuery(gaql) {
  const creds = getCredentials();
  const token = await getAccessToken();
  const url = `${BASE_URL}/customers/${creds.customerId}/googleAds:search`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": creds.developerToken,
        "login-customer-id": creds.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gaql }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google Ads query failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Mutate a resource (budget change, status change, etc.)
async function googleAdsMutate(operations) {
  const creds = getCredentials();
  const token = await getAccessToken();
  const url = `${BASE_URL}/customers/${creds.customerId}:mutate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "developer-token": creds.developerToken,
        "login-customer-id": creds.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mutateOperations: operations }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google Ads mutate failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Strip any secrets from a response before storing/logging
function sanitizeResponse(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const REDACTED_KEYS = ["access_token", "refresh_token", "client_secret", "developer_token"];
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACTED_KEYS.includes(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = sanitizeResponse(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Fetch campaign-level performance for today (and optionally yesterday).
 * Returns array of normalized campaign objects.
 */
async function fetchCampaignPerformance(dateRange = "TODAY") {
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.campaign_budget,
      campaign.start_date,
      campaign.end_date,
      campaign_budget.amount_micros,
      campaign_budget.period,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.all_conversions,
      metrics.view_through_conversions,
      campaign.url_expansion_opt_out,
      campaign.payment_mode
    FROM campaign
    WHERE segments.date DURING ${dateRange}
      AND campaign.status != 'REMOVED'
    ORDER BY campaign.id
  `;

  const data = await googleAdsQuery(gaql);
  const rows = data.results || [];

  return rows.map((row) => ({
    platform: "google",
    external_campaign_id: String(row.campaign?.id || ""),
    campaign_name: row.campaign?.name || "",
    status: row.campaign?.status || "",
    effective_status: row.campaign?.status || "",
    advertising_channel: row.campaign?.advertisingChannelType || "",
    start_date: row.campaign?.startDate || null,
    end_date: row.campaign?.endDate || null,
    budget_micros: row.campaignBudget?.amountMicros || 0,
    budget_cents: Math.round((row.campaignBudget?.amountMicros || 0) / 10_000),
    spend_micros: row.metrics?.costMicros || 0,
    spend_cents: Math.round((row.metrics?.costMicros || 0) / 10_000),
    impressions: Number(row.metrics?.impressions || 0),
    clicks: Number(row.metrics?.clicks || 0),
    conversions: Number(row.metrics?.conversions || 0),
    all_conversions: Number(row.metrics?.allConversions || 0),
    _raw: sanitizeResponse(row),
  }));
}

/**
 * Fetch rejected / policy-disapproved ads for a campaign.
 */
async function fetchRejectedAds(campaignId) {
  const gaql = `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.policy_summary.review_status,
      ad_group_ad.policy_summary.approval_status,
      ad_group_ad.policy_summary.policy_topic_entries,
      ad_group_ad.status,
      ad_group.name,
      campaign.id
    FROM ad_group_ad
    WHERE campaign.id = ${campaignId}
      AND ad_group_ad.policy_summary.approval_status != 'APPROVED'
      AND ad_group_ad.status != 'REMOVED'
  `;
  try {
    const data = await googleAdsQuery(gaql);
    return (data.results || []).map((r) => sanitizeResponse(r));
  } catch (_) {
    return [];
  }
}

/**
 * Update campaign daily budget (in cents). Returns sanitized API response.
 * Caller is responsible for dry-run gating — this executes immediately.
 */
async function setCampaignBudget(campaignBudgetResourceName, newBudgetCents) {
  const operations = [{
    campaignBudgetOperation: {
      update: {
        resourceName: campaignBudgetResourceName,
        amountMicros: String(newBudgetCents * 10_000),
      },
      updateMask: "amount_micros",
    },
  }];
  const result = await googleAdsMutate(operations);
  return sanitizeResponse(result);
}

/**
 * Pause or enable a campaign.
 * @param {string} campaignResourceName e.g. "customers/123/campaigns/456"
 * @param {'PAUSED'|'ENABLED'} newStatus
 */
async function setCampaignStatus(campaignResourceName, newStatus) {
  const operations = [{
    campaignOperation: {
      update: { resourceName: campaignResourceName, status: newStatus },
      updateMask: "status",
    },
  }];
  const result = await googleAdsMutate(operations);
  return sanitizeResponse(result);
}

/**
 * Quick connectivity test — returns true if credentials work.
 */
async function testConnection() {
  try {
    await googleAdsQuery("SELECT customer.id FROM customer LIMIT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  fetchCampaignPerformance,
  fetchRejectedAds,
  setCampaignBudget,
  setCampaignStatus,
  testConnection,
  sanitizeResponse,
};
