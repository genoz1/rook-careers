// Daily match digest — sends each candidate their top 5 newly posted
// jobs (first_seen_at in last 24 hours, scored by match quality).
// Falls back to the 5 most recently ingested jobs if nothing new today.
// Score is not shown in the email — it determines the list but isn't
// displayed. Subject line adapts to reflect new vs recent.

const { sendEmail } = require("./resend");
const { hasFullAccess } = require("../matching");
const { distanceMiles } = require("../geocoding");
const { isUsEligibleJob, resolveUsStateCode } = require("../jobEligibility");
const { scrubCompanyNameFromText, redactForNonSubscriber } = require("../redaction");

const MIN_SCORE_TO_INCLUDE = 60;
const MAX_JOBS_PER_EMAIL = 5;
const MAX_DISTANCE_MILES = 300; // Same geographic radius as the authenticated job explorer.
const MATCH_CANDIDATES_TO_FETCH = 200;

// These strings describe an unrestricted US location, unlike "US PR Remote"
// or "Remote - California". Field sales postings routinely say "remote"
// while still requiring a specific territory, so that word alone is not proof.
function isUnrestrictedUsLocation(location) {
  return /^(?:(?:remote|virtual)\s*[,/_-]\s*)?(?:united states|usa|u\.s\.a\.)(?:\s*[-,/]?\s*(?:remote|nationwide|field based))?$/i.test(String(location || "").trim());
}

function isDigestLocationMatch(job, profile) {
  if (!isUsEligibleJob(job)) return false;

  // If a job names a place, that place wins over a generic "remote" tag.
  // This catches CA/NC/PR territory jobs even when the ad calls them remote.
  if (job.job_lat != null && job.job_lng != null) {
    if (profile.home_lat == null || profile.home_lng == null) return false;
    return distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng) <= MAX_DISTANCE_MILES;
  }

  const jobState = resolveUsStateCode(job.state);
  if (jobState) return jobState === resolveUsStateCode(profile.home_state);

  return isUnrestrictedUsLocation(job.location_raw);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderDigestHtml({ name, jobs, appBaseUrl, subscribed, hasNewJobs }) {
  const rows = jobs
    .map((job) => {
      const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");

      // Subscribers always go straight to the full unmasked job analysis page.
      // Non-subscribers go to the public SSR job page with the trial CTA.
      // This means no redirect logic is needed — the right page is linked directly.
      const detailUrl = subscribed
        ? `${appBaseUrl}/rook-job-analysis.html?job=${encodeURIComponent(job.id)}`
        : job.subscription_required
          ? `${appBaseUrl}/rook-pricing.html`
          : `${appBaseUrl}/jobs/${encodeURIComponent(job.id)}`;

      const companyLine = job.subscription_required
        ? `<span style="color:#7C3AED; font-weight:600;">🔒 Subscribe to see who's hiring</span> · ${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}`
        : `${escapeHtml(job.company_name || "")} · ${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}`;
      const buttonLabel = subscribed ? "View Job" : (job.subscription_required ? "Unlock" : "View Job");
      const isNew = job.first_seen_at && (Date.now() - new Date(job.first_seen_at).getTime()) < 24 * 60 * 60 * 1000;
      const newBadge = isNew ? `<span style="display:inline-block; background:#FFF3E0; color:#E65100; font-size:10px; font-weight:700; padding:2px 7px; border-radius:99px; border:1px solid #FFB74D; margin-left:6px; vertical-align:middle;">🔥 Just Posted</span>` : "";
      return `
        <tr>
          <td style="padding:18px 0; border-bottom:1px solid #E3E8F0;">
            <a href="${detailUrl}" style="color:#1463FF; font-size:16px; font-weight:600; text-decoration:none;">${escapeHtml(job.title_original || "Untitled role")}${newBadge}</a>
            <div style="font-size:13px; color:#5B6B85; margin-top:5px;">${companyLine}</div>
          </td>
          <td width="110" style="padding:18px 0; border-bottom:1px solid #E3E8F0; text-align:right; vertical-align:top; white-space:nowrap;">
            <a href="${detailUrl}" style="background:#071E41; color:#fff; padding:10px 18px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; display:inline-block;">${buttonLabel}</a>
          </td>
        </tr>`;
    })
    .join("");

  const introLine = subscribed
    ? hasNewJobs
      ? `<p style="margin:0; font-size:14px; color:#5B6B85;">New roles matching your location and background:</p>`
      : `<p style="margin:0; font-size:14px; color:#5B6B85;">Your top matches, updated daily:</p>`
    : `<p style="margin:0; font-size:14px; color:#5B6B85;">${jobs.length === 1 ? "This role is" : `These ${jobs.length} roles are`} waiting for you — subscribe to see who's hiring and apply directly:</p>`;

  const footerLine = subscribed
    ? `<a href="${appBaseUrl}/rook-dashboard.html" style="color:#1463FF; font-size:13px; font-weight:600; text-decoration:none;">See all your matches on ROOK →</a>`
    : `<a href="${appBaseUrl}/rook-pricing.html" style="background:#1463FF; color:#fff; padding:12px 24px; border-radius:6px; font-size:14px; font-weight:700; text-decoration:none; display:inline-block;">Join ROOK to see who's hiring →</a>`;

  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#fff;">

      <!-- Header -->
      <div style="background:linear-gradient(135deg, #071E41 0%, #0B2A5C 100%); padding:32px 24px; text-align:center;">
        <div style="margin-bottom:6px;">
          <span style="color:#fff; font-size:30px; font-weight:800; letter-spacing:0.1em; font-family:Georgia,serif;">ROOK</span>
        </div>
        <div style="color:#7BAFD4; font-size:11px; font-weight:600; letter-spacing:0.18em; text-transform:uppercase;">Medical &amp; Veterinary Sales Careers</div>
      </div>

      <!-- Intro -->
      <div style="background:#F5F7FA; padding:20px 24px; text-align:center; border-bottom:1px solid #E3E8F0;">
        <p style="margin:0 0 6px; font-size:16px; font-weight:600; color:#071E41;">Hello ${escapeHtml(name || "there")},</p>
        ${introLine}
      </div>

      <!-- Job rows -->
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 24px;">
        ${rows}
      </table>

      <!-- Footer -->
      <div style="padding:28px 24px; text-align:center; border-top:1px solid #E3E8F0; margin-top:4px;">
        ${footerLine}
        <p style="margin:16px 0 0; font-size:11px; color:#9BAABB;">You're receiving this because you have an active ROOK account.<br>Manage preferences from your dashboard.</p>
      </div>

    </div>`;
}

async function sendDigestForCandidate(supabase, profile, appBaseUrl) {
  if (!profile.email) return { sent: false, reason: "no_email" };
  if (profile.digest_enabled === false) return { sent: false, reason: "opted_out" };

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // ── Step 1: Try newly ingested jobs (first_seen_at in last 24 hours) ──
  const { data: newMatchRows, error: newErr } = await supabase
    .from("candidate_job_matches")
    .select("*, jobs!inner(*)")
    .eq("candidate_id", profile.id)
    .eq("dismissed", false)
    .eq("jobs.status", "active")
    .eq("jobs.moderation_status", "approved")
    .gte("jobs.first_seen_at", cutoff24h)
    .order("overall_score", { ascending: false })
    .limit(MATCH_CANDIDATES_TO_FETCH);

  if (newErr) throw new Error(`Could not load new matches: ${newErr.message}`);

  const freshLocal = (newMatchRows || []).filter((r) => isDigestLocationMatch(r.jobs, profile));
  const freshScored = freshLocal
    .filter((r) => (r.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE)
    .slice(0, MAX_JOBS_PER_EMAIL);

  let matchRows = freshScored;
  let hasNewJobs = freshScored.length > 0;

  // ── Step 2: Fall back to most recently ingested if not enough new ──
  if (matchRows.length < MAX_JOBS_PER_EMAIL) {
    const { data: recentRows, error: recentErr } = await supabase
      .from("candidate_job_matches")
      .select("overall_score,recommendation,jobs!inner(id,first_seen_at,location_raw,state,job_lat,job_lng,location_evidence)")
      .eq("candidate_id", profile.id)
      .eq("dismissed", false)
      .eq("jobs.status", "active")
      .eq("jobs.moderation_status", "approved")
      .order("jobs(first_seen_at)", { ascending: false })
      .limit(MATCH_CANDIDATES_TO_FETCH);

    if (recentErr) throw new Error(`Could not load recent matches: ${recentErr.message}`);

    const existingIds = new Set(matchRows.map((r) => r.jobs?.id));
    const recentLocal = (recentRows || []).filter(
      (r) =>
        !existingIds.has(r.jobs?.id) &&
        isDigestLocationMatch(r.jobs, profile) &&
        (r.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE
    );
    // Sort/filter the same 200 candidates using only selection evidence. Avoid
    // materializing complete job documents across the relationship sort.
    const additions = recentLocal.slice(0, MAX_JOBS_PER_EMAIL - matchRows.length);
    if (additions.length) {
      const { data: details, error: detailErr } = await supabase.from("jobs")
        .select("*").in("id", additions.map(r => r.jobs.id))
        .eq("status", "active").eq("moderation_status", "approved");
      if (detailErr) throw new Error(`Could not load recent job details: ${detailErr.message}`);
      const byId = new Map((details || []).map(job => [job.id, job]));
      if (additions.some(r => !byId.has(r.jobs.id))) {
        throw new Error("Recent job details changed during digest selection");
      }
      matchRows = [...matchRows, ...additions.map(r => ({ ...r, jobs: byId.get(r.jobs.id) }))];
    }
  }

  if (matchRows.length === 0) return { sent: false, reason: "no_qualifying_matches" };

  const scored = matchRows.map((row) => ({
    ...row.jobs,
    match: {
      overall_score: row.overall_score,
      excellent_match: row.overall_score >= 85,
      recommendation: row.recommendation,
    },
  }));

  const hasAccess = hasFullAccess(profile);
  const emailJobs = hasAccess ? scored : scored.map(redactForNonSubscriber);

  const html = renderDigestHtml({ name: profile.name, jobs: emailJobs, appBaseUrl, subscribed: hasAccess, hasNewJobs });

  const subjectNew = `🔥 ${freshScored.length} new medical sales job${freshScored.length === 1 ? "" : "s"} matching your location`;
  const subjectFallback = `Your top ${scored.length} medical sales match${scored.length === 1 ? "" : "es"} on ROOK`;
  const subjectNonSub = `${scored.length} job${scored.length === 1 ? "" : "s"} waiting for you on ROOK — see who's hiring`;

  await sendEmail({
    to: profile.email,
    subject: hasAccess ? (hasNewJobs ? subjectNew : subjectFallback) : subjectNonSub,
    html,
  });

  return { sent: true, jobCount: scored.length };
}

module.exports = { escapeHtml, sendDigestForCandidate, renderDigestHtml, isDigestLocationMatch };
