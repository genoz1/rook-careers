// ROOK Ad Manager — Budget Policy Engine
//
// Pure, stateless decision functions. No I/O, no database calls, no API
// calls. Takes a campaign snapshot + controls row + recent history and
// returns a list of proposed actions. The caller (manager.js) decides
// whether to execute them based on the operating mode.
//
// Design principles:
//  1. Conservative by default — do less, not more.
//  2. Every decision is traced to a named rule with a human-readable reason.
//  3. All monetary values are in USD cents throughout.
//  4. Thresholds are configurable via env vars with safe defaults.

// ── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // CPA targets (cost per conversion in cents)
  cpa_target_cents: parseInt(process.env.AD_CPA_TARGET_CENTS || "2000"),         // $20
  cpa_pause_threshold: parseFloat(process.env.AD_CPA_PAUSE_THRESHOLD || "3.0"),  // pause if CPA > 3× target
  cpa_scale_threshold: parseFloat(process.env.AD_CPA_SCALE_THRESHOLD || "0.7"),  // scale if CPA < 0.7× target

  // CTR thresholds
  ctr_warning_pct: parseFloat(process.env.AD_CTR_WARNING_PCT || "0.3"),    // warn if CTR < 0.3%
  ctr_pause_pct: parseFloat(process.env.AD_CTR_PAUSE_PCT || "0.1"),        // pause if CTR < 0.1%

  // Budget adjustment step
  budget_scale_up_pct: parseFloat(process.env.AD_BUDGET_SCALE_UP_PCT || "0.20"),    // +20%
  budget_scale_down_pct: parseFloat(process.env.AD_BUDGET_SCALE_DOWN_PCT || "0.15"), // −15%

  // Minimum data before making budget decisions
  min_clicks_for_budget_decision: parseInt(process.env.AD_MIN_CLICKS || "20"),
  min_spend_cents_for_decision: parseInt(process.env.AD_MIN_SPEND_CENTS || "500"), // $5

  // Zero-spend window (hours before flagging stopped delivery)
  zero_spend_alert_hours: parseInt(process.env.AD_ZERO_SPEND_HOURS || "6"),

  // Total daily budget cap across all platforms combined (cents)
  total_daily_budget_cap_cents: parseInt(process.env.AD_TOTAL_DAILY_BUDGET_CAP_CENTS || "10000"), // $100
};

// ── Helper functions ────────────────────────────────────────────────────────

function ctr(clicks, impressions) {
  return impressions > 0 ? (clicks / impressions) * 100 : null;
}

function cpa(spendCents, conversions) {
  return conversions > 0 ? Math.round(spendCents / conversions) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctChange(from, to) {
  if (!from) return null;
  return ((to - from) / from) * 100;
}

// ── Alert rules ─────────────────────────────────────────────────────────────

/**
 * Inspect a campaign snapshot for alert conditions.
 * @returns {Array} array of alert objects {severity, alert_type, message, details}
 */
function evaluateAlerts(snapshot, controls) {
  const alerts = [];

  // 1. Effective delivery status check
  const stopped = ["PAUSED", "STOPPED", "CAMPAIGN_PAUSED", "DISAPPROVED",
                   "ACCOUNT_PAUSED", "BILLING_ERROR", "CAMPAIGN_GROUP_PAUSED"];
  const effectiveStatus = (snapshot.effective_status || "").toUpperCase();
  if (stopped.includes(effectiveStatus) && controls.desired_state === "active") {
    alerts.push({
      severity: "critical",
      alert_type: "campaign_stopped",
      message: `${snapshot.platform}/${snapshot.external_campaign_id} "${snapshot.campaign_name}" is not delivering (status: ${effectiveStatus}) but desired_state is 'active'.`,
      details: { effective_status: effectiveStatus, desired_state: controls.desired_state },
    });
  }

  // 2. Zero spend after active hours
  if (snapshot.spend_cents === 0 && controls.desired_state === "active") {
    alerts.push({
      severity: "warning",
      alert_type: "zero_spend",
      message: `${snapshot.platform}/${snapshot.external_campaign_id} "${snapshot.campaign_name}" has $0 spend today with desired_state 'active'.`,
      details: { spend_cents: 0 },
    });
  }

  // 3. Destination URL check (landing URL must contain expected path)
  const rawUrl = JSON.stringify(snapshot._raw || {});
  if (controls.destination_url && rawUrl.length > 0) {
    const expectedPath = new URL(controls.destination_url).pathname;
    if (!rawUrl.includes(expectedPath)) {
      alerts.push({
        severity: "warning",
        alert_type: "wrong_destination_url",
        message: `${snapshot.platform}/${snapshot.external_campaign_id} "${snapshot.campaign_name}" may not be sending traffic to ${expectedPath}. Verify ad destination URL.`,
        details: { expected_path: expectedPath },
      });
    }
  }

  // 4. CTR too low
  const ctrValue = ctr(snapshot.clicks, snapshot.impressions);
  if (ctrValue !== null && snapshot.impressions > 1000) {
    if (ctrValue < CONFIG.ctr_pause_pct) {
      alerts.push({
        severity: "warning",
        alert_type: "low_ctr",
        message: `${snapshot.platform}/${snapshot.external_campaign_id} CTR is ${ctrValue.toFixed(3)}% (below pause threshold ${CONFIG.ctr_pause_pct}%).`,
        details: { ctr_pct: ctrValue, impressions: snapshot.impressions, threshold: CONFIG.ctr_pause_pct },
      });
    } else if (ctrValue < CONFIG.ctr_warning_pct) {
      alerts.push({
        severity: "info",
        alert_type: "low_ctr",
        message: `${snapshot.platform}/${snapshot.external_campaign_id} CTR is ${ctrValue.toFixed(3)}% (below warning threshold ${CONFIG.ctr_warning_pct}%).`,
        details: { ctr_pct: ctrValue, impressions: snapshot.impressions, threshold: CONFIG.ctr_warning_pct },
      });
    }
  }

  // 5. High CPA
  const cpaValue = cpa(snapshot.spend_cents, snapshot.conversions || snapshot.conversions_landing || 0);
  if (cpaValue !== null && snapshot.spend_cents >= CONFIG.min_spend_cents_for_decision) {
    const maxCpa = CONFIG.cpa_target_cents * CONFIG.cpa_pause_threshold;
    if (cpaValue > maxCpa) {
      alerts.push({
        severity: "warning",
        alert_type: "high_cpa",
        message: `${snapshot.platform}/${snapshot.external_campaign_id} CPA is $${(cpaValue / 100).toFixed(2)} (>${CONFIG.cpa_pause_threshold}× target $${(CONFIG.cpa_target_cents / 100).toFixed(2)}).`,
        details: { cpa_cents: cpaValue, target_cents: CONFIG.cpa_target_cents, threshold_multiplier: CONFIG.cpa_pause_threshold },
      });
    }
  }

  return alerts;
}

// ── Budget adjustment rules ──────────────────────────────────────────────────

/**
 * Decide whether to adjust, pause, or skip this campaign.
 * @param {object} snapshot    - normalized performance snapshot
 * @param {object} controls    - ad_campaign_controls row
 * @param {object} [history]   - optional recent snapshots summary {avg_cpa_cents, trend}
 * @returns {Array}            - list of proposed actions
 */
function evaluateBudgetPolicy(snapshot, controls, history = {}) {
  const actions = [];

  // Gate 1: must be approved for automation
  if (!controls.approved_for_automation) {
    actions.push({
      action_type: "skip_no_approval",
      reason: "approved_for_automation is false — skipping all automatic adjustments",
      proposed_value: null,
    });
    return actions;
  }

  // Gate 2: must be desired active
  if (controls.desired_state !== "active") {
    actions.push({
      action_type: "skip_not_desired_active",
      reason: `desired_state is '${controls.desired_state}' — skipping budget evaluation`,
      proposed_value: null,
    });
    return actions;
  }

  // Gate 3: not enough data for decisions
  const conversions = snapshot.conversions || snapshot.conversions_landing || 0;
  const hasEnoughData =
    snapshot.clicks >= CONFIG.min_clicks_for_budget_decision &&
    snapshot.spend_cents >= CONFIG.min_spend_cents_for_decision;

  if (!hasEnoughData) {
    actions.push({
      action_type: "skip_insufficient_data",
      reason: `Only ${snapshot.clicks} clicks / $${(snapshot.spend_cents / 100).toFixed(2)} spend today — need ${CONFIG.min_clicks_for_budget_decision} clicks and $${(CONFIG.min_spend_cents_for_decision / 100).toFixed(2)} to adjust budget`,
      proposed_value: null,
    });
    return actions;
  }

  // Current budget
  const currentBudgetCents = snapshot.daily_budget_cents || snapshot.budget_cents || 0;
  if (!currentBudgetCents) {
    actions.push({
      action_type: "skip_no_budget_info",
      reason: "Could not determine current daily budget from API response",
      proposed_value: null,
    });
    return actions;
  }

  // Combined budget guard: never let a single campaign's budget exceed
  // the combined daily cap. This prevents compounding scale-ups from
  // pushing the portfolio far above the intended $25/day total.
  const combinedCap = parseInt(process.env.AD_COMBINED_DAILY_BUDGET_CENTS || "2500"); // $25.00
  const maxPerCampaign = clamp(
    Math.min(controls.max_daily_budget_cents, combinedCap),
    controls.min_daily_budget_cents,
    controls.max_daily_budget_cents
  );

  const cpaValue = cpa(snapshot.spend_cents, conversions);
  const ctrValue = ctr(snapshot.clicks, snapshot.impressions);
  const maxCpa = CONFIG.cpa_target_cents * CONFIG.cpa_pause_threshold;
  const goodCpa = CONFIG.cpa_target_cents * CONFIG.cpa_scale_threshold;

  // Rule A: Pause if CPA too high
  if (cpaValue !== null && cpaValue > maxCpa) {
    actions.push({
      action_type: "recommend_pause",
      reason: `CPA $${(cpaValue / 100).toFixed(2)} exceeds ${CONFIG.cpa_pause_threshold}× target ($${(maxCpa / 100).toFixed(2)}). Recommend pausing for creative/audience review.`,
      proposed_value: { suggested_status: "PAUSED", cpa_cents: cpaValue, threshold_cents: maxCpa },
    });
    return actions;
  }

  // Rule B: Scale up if CPA is well below target
  if (cpaValue !== null && cpaValue < goodCpa) {
    const increased = Math.round(currentBudgetCents * (1 + CONFIG.budget_scale_up_pct));
    const newBudget = clamp(increased, controls.min_daily_budget_cents, maxPerCampaign);
    if (newBudget > currentBudgetCents) {
      actions.push({
        action_type: "increase_budget",
        reason: `CPA $${(cpaValue / 100).toFixed(2)} is below ${CONFIG.cpa_scale_threshold}× target — performance is strong. Increasing budget +${(CONFIG.budget_scale_up_pct * 100).toFixed(0)}%.`,
        proposed_value: {
          new_daily_budget_cents: newBudget,
          previous_daily_budget_cents: currentBudgetCents,
          pct_change: pctChange(currentBudgetCents, newBudget),
        },
        previous_value: { daily_budget_cents: currentBudgetCents },
      });
    }
    return actions;
  }

  // Rule C: Reduce budget if CTR is very low (creative fatigue / poor targeting)
  if (ctrValue !== null && ctrValue < CONFIG.ctr_pause_pct && snapshot.impressions > 5000) {
    const decreased = Math.round(currentBudgetCents * (1 - CONFIG.budget_scale_down_pct));
    const newBudget = clamp(decreased, controls.min_daily_budget_cents, controls.max_daily_budget_cents);
    if (newBudget < currentBudgetCents) {
      actions.push({
        action_type: "decrease_budget",
        reason: `CTR ${ctrValue.toFixed(3)}% is very low with ${snapshot.impressions.toLocaleString()} impressions — possible creative fatigue. Reducing budget −${(CONFIG.budget_scale_down_pct * 100).toFixed(0)}%.`,
        proposed_value: {
          new_daily_budget_cents: newBudget,
          previous_daily_budget_cents: currentBudgetCents,
          pct_change: pctChange(currentBudgetCents, newBudget),
        },
        previous_value: { daily_budget_cents: currentBudgetCents },
      });
    }
    return actions;
  }

  // Rule D: No action needed
  actions.push({
    action_type: "no_action",
    reason: `Performance within acceptable range. CTR ${ctrValue !== null ? ctrValue.toFixed(3) + "%" : "n/a"}, CPA ${cpaValue !== null ? "$" + (cpaValue / 100).toFixed(2) : "n/a"}, spend $${(snapshot.spend_cents / 100).toFixed(2)}.`,
    proposed_value: null,
  });

  return actions;
}

/**
 * Cross-platform total budget check.
 * If combined daily budgets exceed the cap, flag the most expensive platform.
 * @param {Array} snapshots  - one per campaign, must have daily_budget_cents
 * @returns {Array}          - alerts if over budget
 */
function evaluateTotalBudgetCap(snapshots) {
  const alerts = [];
  const totalBudget = snapshots.reduce((sum, s) => sum + (s.daily_budget_cents || 0), 0);
  if (totalBudget > CONFIG.total_daily_budget_cap_cents) {
    alerts.push({
      severity: "warning",
      alert_type: "total_budget_cap_exceeded",
      message: `Combined daily budget $${(totalBudget / 100).toFixed(2)} exceeds cap $${(CONFIG.total_daily_budget_cap_cents / 100).toFixed(2)}.`,
      details: {
        total_budget_cents: totalBudget,
        cap_cents: CONFIG.total_daily_budget_cap_cents,
        by_platform: snapshots.reduce((acc, s) => {
          acc[s.platform] = (acc[s.platform] || 0) + (s.daily_budget_cents || 0);
          return acc;
        }, {}),
      },
    });
  }
  return alerts;
}

module.exports = {
  evaluateAlerts,
  evaluateBudgetPolicy,
  evaluateTotalBudgetCap,
  CONFIG,
  // Exposed for tests
  ctr,
  cpa,
  clamp,
  pctChange,
};
