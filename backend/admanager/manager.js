// ROOK Ad Manager — Main Orchestrator
//
// Entry point for every scheduled health-check run.
// Fetches performance, evaluates policy, executes (or simulates) actions,
// writes audit records, sends alerts when needed.
//
// Operating modes (set via AD_MANAGER_MODE env var):
//   'off'      — does nothing (default, safe)
//   'dry-run'  — fetches real data, evaluates policy, logs everything, executes nothing
//   'write'    — fetches, evaluates, and executes approved actions
//
// Usage:
//   node backend/admanager/manager.js
//   AD_MANAGER_MODE=dry-run node backend/admanager/manager.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { sendEmail } = require("../email/resend");
const google = require("./clients/google");
const meta   = require("./clients/meta");
const reddit  = require("./clients/reddit");
const policy  = require("./policy");

// ── Supabase ───────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Mode ───────────────────────────────────────────────────────────────────

const MODE = (process.env.AD_MANAGER_MODE || "off").toLowerCase();
const ALERT_EMAIL = process.env.AD_MANAGER_ALERT_EMAIL || process.env.ADMIN_EMAILS?.split(",")[0];

function log(msg) {
  console.log(`[ad-manager][${MODE}] ${new Date().toISOString()} ${msg}`);
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function getControlsForPlatform(platform) {
  const { data, error } = await supabase
    .from("ad_campaign_controls")
    .select("*")
    .eq("platform", platform);
  if (error) throw new Error(`DB controls fetch failed (${platform}): ${error.message}`);
  return data || [];
}

async function insertSnapshot(snapshot, campaignControl) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("ad_performance_snapshots").insert({
    campaign_control_id: campaignControl?.id || null,
    platform: snapshot.platform,
    external_campaign_id: snapshot.external_campaign_id,
    snapshot_date: today,
    snapshot_hour: new Date().getUTCHours(),
    spend_cents: snapshot.spend_cents || 0,
    impressions: snapshot.impressions || 0,
    clicks: snapshot.clicks || 0,
    conversions_landing: snapshot.conversions_landing || 0,
    conversions_onboarding: snapshot.conversions_onboarding || 0,
    conversions_trial: snapshot.conversions_trial || 0,
    effective_status: snapshot.effective_status || "",
    raw_api_response: snapshot._raw || null,
    fetched_at: new Date().toISOString(),
  });
}

async function logAction(action, mode, platform, externalId, controlId, executed, apiResponse, error) {
  await supabase.from("ad_manager_actions").insert({
    mode,
    platform,
    external_campaign_id: externalId,
    campaign_control_id: controlId,
    action_type: action.action_type,
    reason: action.reason,
    proposed_value: action.proposed_value || null,
    previous_value: action.previous_value || null,
    executed,
    api_response: apiResponse || null,
    error: error || null,
  });
}

async function raiseAlert(alert, platform, externalId, controlId) {
  const { data: existing } = await supabase
    .from("ad_manager_alerts")
    .select("id")
    .eq("alert_type", alert.alert_type)
    .eq("external_campaign_id", externalId || "")
    .eq("resolved", false)
    .limit(1);

  // Don't duplicate open alerts of the same type for the same campaign
  if (existing?.length) return;

  await supabase.from("ad_manager_alerts").insert({
    severity: alert.severity,
    alert_type: alert.alert_type,
    platform,
    external_campaign_id: externalId || null,
    campaign_control_id: controlId || null,
    message: alert.message,
    details: alert.details || null,
    email_sent: false,
  });

  if (alert.severity === "critical" && ALERT_EMAIL) {
    try {
      await sendEmail({
        to: ALERT_EMAIL,
        subject: `🚨 ROOK Ad Manager: ${alert.alert_type} on ${platform}`,
        html: `<p><strong>Alert:</strong> ${alert.message}</p><pre>${JSON.stringify(alert.details, null, 2)}</pre><p>Mode: ${MODE}</p>`,
      });
      await supabase
        .from("ad_manager_alerts")
        .update({ email_sent: true })
        .eq("alert_type", alert.alert_type)
        .eq("external_campaign_id", externalId || "")
        .eq("resolved", false);
    } catch (err) {
      log(`Failed to send alert email: ${err.message}`);
    }
  }
}

// ── Platform runner ────────────────────────────────────────────────────────

async function runPlatform(platformName, fetchFn, setBudgetFn, setStatusFn) {
  log(`--- ${platformName.toUpperCase()} ---`);
  const summary = { platform: platformName, snapshots: 0, actions: 0, alerts: 0, errors: [] };

  let snapshots;
  try {
    snapshots = await fetchFn();
    log(`  Fetched ${snapshots.length} campaigns`);
  } catch (err) {
    log(`  FETCH ERROR: ${err.message}`);
    summary.errors.push(`fetch: ${err.message}`);
    return summary;
  }

  const controls = await getControlsForPlatform(platformName);
  const controlMap = new Map(controls.map((c) => [c.external_campaign_id, c]));

  // Cross-platform total budget check
  const budgetAlerts = policy.evaluateTotalBudgetCap(snapshots);
  for (const alert of budgetAlerts) {
    await raiseAlert(alert, platformName, null, null);
    summary.alerts++;
  }

  for (const snapshot of snapshots) {
    try {
      await insertSnapshot(snapshot, controlMap.get(snapshot.external_campaign_id) || null);
      summary.snapshots++;
    } catch (err) {
      log(`  Snapshot insert error for ${snapshot.external_campaign_id}: ${err.message}`);
    }

    const controls_row = controlMap.get(snapshot.external_campaign_id);

    // Alerts — always evaluate even without a controls row
    const alerts = policy.evaluateAlerts(snapshot, controls_row || {
      desired_state: "active",
      destination_url: "https://rookcareers.com/rook-onboarding-v4.html",
    });
    for (const alert of alerts) {
      log(`  [ALERT:${alert.severity.toUpperCase()}] ${alert.alert_type}: ${alert.message}`);
      await raiseAlert(alert, platformName, snapshot.external_campaign_id, controls_row?.id || null);
      summary.alerts++;
    }

    // Budget policy — only for campaigns with a controls row
    if (!controls_row) {
      log(`  ${snapshot.external_campaign_id} "${snapshot.campaign_name}" — no controls row, skipping policy`);
      continue;
    }

    const actions = policy.evaluateBudgetPolicy(snapshot, controls_row);
    for (const action of actions) {
      log(`  [ACTION:${action.action_type}] ${action.reason}`);

      if (["no_action", "skip_no_approval", "skip_not_desired_active", "skip_insufficient_data", "skip_no_budget_info"].includes(action.action_type)) {
        await logAction(action, MODE, platformName, snapshot.external_campaign_id, controls_row.id, false, null, null);
        continue;
      }

      if (MODE === "dry-run") {
        log(`  [DRY-RUN] Would execute: ${action.action_type} with ${JSON.stringify(action.proposed_value)}`);
        await logAction(action, "dry-run", platformName, snapshot.external_campaign_id, controls_row.id, false, null, null);
        summary.actions++;
        continue;
      }

      if (MODE !== "write") continue; // dry-run: proposed only, write: execute

      // Execute the action
      let apiResponse = null;
      let execError = null;
      try {
        if (action.action_type === "increase_budget" || action.action_type === "decrease_budget") {
          const newBudget = action.proposed_value.new_daily_budget_cents;
          apiResponse = await setBudgetFn(snapshot.external_campaign_id, newBudget);
          log(`  [WRITE] Set ${platformName} budget for ${snapshot.external_campaign_id} to $${(newBudget / 100).toFixed(2)}`);
          // Update controls row
          await supabase.from("ad_campaign_controls")
            .update({ last_action: action.action_type, last_action_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", controls_row.id);
        } else if (action.action_type === "recommend_pause") {
          const newStatus = platformName === "google" ? "PAUSED" : "PAUSED";
          apiResponse = await setStatusFn(snapshot.external_campaign_id, newStatus);
          log(`  [WRITE] Paused ${platformName} campaign ${snapshot.external_campaign_id}`);
          await supabase.from("ad_campaign_controls")
            .update({ last_action: "pause_campaign", last_action_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", controls_row.id);
        }
        await logAction(action, "write", platformName, snapshot.external_campaign_id, controls_row.id, true, apiResponse, null);
        summary.actions++;
      } catch (err) {
        execError = err.message;
        log(`  [WRITE ERROR] ${action.action_type} failed: ${err.message}`);
        await logAction(action, "write", platformName, snapshot.external_campaign_id, controls_row.id, false, null, execError);
        summary.errors.push(`${action.action_type}: ${execError}`);
      }
    }
  }

  return summary;
}

// ── Daily summary email ────────────────────────────────────────────────────

async function sendDailySummary(summaries) {
  if (!ALERT_EMAIL) return;
  const today = new Date().toISOString().slice(0, 10);
  const rows = summaries.map((s) => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;">${s.platform}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${s.snapshots}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${s.actions}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">${s.alerts}</td>
      <td style="padding:8px;border:1px solid #ddd;">${s.errors.length ? s.errors.join("; ") : "—"}</td>
    </tr>`).join("");

  const { data: openAlerts } = await supabase
    .from("ad_manager_alerts")
    .select("severity, alert_type, platform, message")
    .eq("resolved", false)
    .order("created_at", { ascending: false })
    .limit(10);

  const alertRows = (openAlerts || []).map((a) =>
    `<tr><td style="padding:6px;border:1px solid #ddd;">${a.severity.toUpperCase()}</td><td style="padding:6px;border:1px solid #ddd;">${a.platform || "—"}</td><td style="padding:6px;border:1px solid #ddd;">${a.message}</td></tr>`
  ).join("");

  await sendEmail({
    to: ALERT_EMAIL,
    subject: `📊 ROOK Ad Manager Summary — ${today} (mode: ${MODE})`,
    html: `
      <h2 style="color:#071E41;">ROOK Ad Manager — ${today}</h2>
      <p>Mode: <strong>${MODE}</strong></p>
      <h3>Platform Summary</h3>
      <table style="border-collapse:collapse;width:100%;">
        <tr style="background:#f5f5f5;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Platform</th>
          <th style="padding:8px;border:1px solid #ddd;">Snapshots</th>
          <th style="padding:8px;border:1px solid #ddd;">Actions</th>
          <th style="padding:8px;border:1px solid #ddd;">Alerts</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Errors</th>
        </tr>
        ${rows}
      </table>
      ${openAlerts?.length ? `
      <h3>Open Alerts (${openAlerts.length})</h3>
      <table style="border-collapse:collapse;width:100%;">
        <tr style="background:#f5f5f5;"><th style="padding:6px;border:1px solid #ddd;">Severity</th><th style="padding:6px;border:1px solid #ddd;">Platform</th><th style="padding:6px;border:1px solid #ddd;">Message</th></tr>
        ${alertRows}
      </table>` : "<p>✅ No open alerts.</p>"}
    `,
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  log(`Starting ad manager run (mode=${MODE})`);

  if (MODE === "off") {
    log("Mode is 'off' — exiting without doing anything");
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log("ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    process.exit(1);
  }

  const summaries = [];
  const enabledPlatforms = (process.env.AD_ENABLED_PLATFORMS || "google,meta,reddit")
    .split(",").map((p) => p.trim().toLowerCase());

  if (enabledPlatforms.includes("google") && process.env.GOOGLE_ADS_CUSTOMER_ID) {
    try {
      const s = await runPlatform("google",
        () => google.fetchCampaignPerformance("TODAY"),
        google.setCampaignBudget,
        (id, status) => google.setCampaignStatus(`customers/${process.env.GOOGLE_ADS_CUSTOMER_ID}/campaigns/${id}`, status)
      );
      summaries.push(s);
    } catch (err) {
      log(`Google platform error: ${err.message}`);
      summaries.push({ platform: "google", snapshots: 0, actions: 0, alerts: 0, errors: [err.message] });
    }
  } else if (enabledPlatforms.includes("google")) {
    log("Google: GOOGLE_ADS_CUSTOMER_ID not set — skipping");
  }

  if (enabledPlatforms.includes("meta") && process.env.META_ADS_ACCOUNT_ID) {
    try {
      const s = await runPlatform("meta",
        () => meta.fetchCampaignPerformance("today"),
        meta.setCampaignBudget,
        meta.setCampaignStatus
      );
      summaries.push(s);
    } catch (err) {
      log(`Meta platform error: ${err.message}`);
      summaries.push({ platform: "meta", snapshots: 0, actions: 0, alerts: 0, errors: [err.message] });
    }
  } else if (enabledPlatforms.includes("meta")) {
    log("Meta: META_ADS_ACCOUNT_ID not set — skipping");
  }

  if (enabledPlatforms.includes("reddit") && process.env.REDDIT_ADS_ACCOUNT_ID) {
    try {
      const s = await runPlatform("reddit",
        () => reddit.fetchCampaignPerformance(),
        reddit.setCampaignBudget,
        reddit.setCampaignStatus
      );
      summaries.push(s);
    } catch (err) {
      log(`Reddit platform error: ${err.message}`);
      summaries.push({ platform: "reddit", snapshots: 0, actions: 0, alerts: 0, errors: [err.message] });
    }
  } else if (enabledPlatforms.includes("reddit")) {
    log("Reddit: REDDIT_ADS_ACCOUNT_ID not set — skipping");
  }

  // Daily summary (once per day, around EOD Eastern)
  const hour = new Date().getUTCHours();
  if (hour >= 23 || hour === 0) {
    try {
      await sendDailySummary(summaries);
      log("Daily summary email sent");
    } catch (err) {
      log(`Summary email failed: ${err.message}`);
    }
  }

  const totalActions = summaries.reduce((s, p) => s + p.actions, 0);
  const totalAlerts  = summaries.reduce((s, p) => s + p.alerts, 0);
  const totalErrors  = summaries.flatMap((p) => p.errors);
  log(`Run complete: ${totalActions} actions, ${totalAlerts} alerts, ${totalErrors.length} errors`);

  if (totalErrors.length) {
    log(`Errors: ${totalErrors.join("; ")}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[ad-manager] Fatal error:", err.message);
  process.exit(1);
});
