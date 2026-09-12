// Daily match digest — sends each candidate their top 5 newly posted
// jobs (first_seen_at in last 24 hours, scored by match quality).
// Falls back to the 5 most recently ingested jobs if nothing new today.
// Score is not shown in the email — it determines the list but isn't
// displayed. Subject line adapts to reflect new vs recent.

const { sendEmail } = require("./resend");
const { mentionsNonUsCountry, hasFullAccess } = require("../matching");
const { scrubCompanyNameFromText, redactForNonSubscriber } = require("../routes/jobs");

const MIN_SCORE_TO_INCLUDE = 60;
const MAX_JOBS_PER_EMAIL = 5;

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
      ? `<p style="margin:0; font-size:14px; color:#5B6B85;">New roles posted in your area — matched to your background:</p>`
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
    .limit(MAX_JOBS_PER_EMAIL * 4);

  if (newErr) throw new Error(`Could not load new matches: ${newErr.message}`);

  const freshDomestic = (newMatchRows || []).filter(
    (r) => !mentionsNonUsCountry(r.jobs?.location_raw, r.jobs?.job_lng, r.jobs?.title_original)
  );
  const freshScored = freshDomestic
    .filter((r) => (r.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE)
    .slice(0, MAX_JOBS_PER_EMAIL);

  let matchRows = freshScored;
  let hasNewJobs = freshScored.length > 0;

  // ── Step 2: Fall back to most recently ingested if not enough new ──
  if (matchRows.length < MAX_JOBS_PER_EMAIL) {
    const { data: recentRows, error: recentErr } = await supabase
      .from("candidate_job_matches")
      .select("*, jobs!inner(*)")
      .eq("candidate_id", profile.id)
      .eq("dismissed", false)
      .eq("jobs.status", "active")
      .eq("jobs.moderation_status", "approved")
      .order("jobs.first_seen_at", { ascending: false })
      .limit(MAX_JOBS_PER_EMAIL * 4);

    if (recentErr) throw new Error(`Could not load recent matches: ${recentErr.message}`);

    const existingIds = new Set(matchRows.map((r) => r.jobs?.id));
    const recentDomestic = (recentRows || []).filter(
      (r) =>
        !existingIds.has(r.jobs?.id) &&
        !mentionsNonUsCountry(r.jobs?.location_raw, r.jobs?.job_lng, r.jobs?.title_original) &&
        (r.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE
    );
    matchRows = [...matchRows, ...recentDomestic].slice(0, MAX_JOBS_PER_EMAIL);
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

  const subjectNew = `🔥 ${freshScored.length} new medical sales job${freshScored.length === 1 ? "" : "s"} posted near you`;
  const subjectFallback = `Your top ${scored.length} medical sales match${scored.length === 1 ? "" : "es"} on ROOK`;
  const subjectNonSub = `${scored.length} job${scored.length === 1 ? "" : "s"} waiting for you on ROOK — see who's hiring`;

  await sendEmail({
    to: profile.email,
    subject: hasAccess ? (hasNewJobs ? subjectNew : subjectFallback) : subjectNonSub,
    html,
  });

  return { sent: true, jobCount: scored.length };
}

module.exports = { sendDigestForCandidate, renderDigestHtml };
