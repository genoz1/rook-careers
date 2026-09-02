// Daily match digest — the email itself (styled the way real job-board
// digest emails work, e.g. MedReps' daily email) and the per-candidate
// logic that decides what goes in it.
//
// Sends each candidate's top 10 overall matches (by precomputed
// overall_score), regardless of whether they're newly seen or have
// been sitting in their match list for a while - a candidate's best
// real opportunities don't stop being worth surfacing just because
// nothing new happened to appear since yesterday.
//
// A candidate with zero qualifying jobs this run gets no email at all —
// an empty "no matches today" email has no value and just trains people
// to ignore ROOK's emails.

const { sendEmail } = require("./resend");
const { mentionsNonUsCountry } = require("../matching");
const { isSubscribed, scrubCompanyNameFromText, redactForNonSubscriber } = require("../routes/jobs");

// 60, not 70 ("Stretch Apply" tier) — chosen after testing against a
// realistic minimal profile (just home_state + minimum_base_salary, no
// résumé/travel/industry data yet) showed a job that correctly matched
// location and was freshly posted, with only unmapped compensation data
// on the job's side, scoring 68% — just under 70. Most real ROOK
// profiles won't have every optional field filled in, so a 70+ cutoff
// would silently exclude genuinely reasonable matches with no visible
// error. 60 stays well above "Skip" territory while not punishing
// candidates for gaps that are the job posting's fault, not theirs.
const MIN_SCORE_TO_INCLUDE = 60;
const MAX_JOBS_PER_EMAIL = 10;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderDigestHtml({ name, jobs, appBaseUrl, subscribed }) {
  const rows = jobs
    .map((job) => {
      const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");
      // A non-subscribed recipient's jobs have already been through
      // redactForNonSubscriber, which sets subscription_required and
      // strips company_name/source_url — this just decides what the
      // row and button say/link to based on that, the same "who's
      // hiring" gate the Dashboard and every other surface use.
      const detailUrl = job.subscription_required
        ? `${appBaseUrl}/rook-pricing.html`
        : `${appBaseUrl}/rook-job-analysis.html?job=${encodeURIComponent(job.id)}`;
      const companyLine = job.subscription_required
        ? `<span style="color:#7C3AED; font-weight:600;">🔒 Subscribe to see who's hiring</span> · ${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}`
        : `${escapeHtml(job.company_name || "")} · ${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}`;
      const buttonLabel = job.subscription_required ? "Unlock" : "View Job";
      return `
        <tr>
          <td style="padding:18px 0; border-bottom:1px solid #E3E8F0;">
            <a href="${detailUrl}" style="color:#1463FF; font-size:16px; font-weight:600; text-decoration:none;">${escapeHtml(job.title_original || "Untitled role")}</a>
            <div style="font-size:13px; color:#5B6B85; margin-top:4px;">
              ${companyLine}
            </div>
            ${job.match?.overall_score != null ? `<div style="font-size:12px; color:#12B8A6; font-weight:600; margin-top:4px;">${job.match.overall_score}% match${job.match.recommendation ? " · " + escapeHtml(job.match.recommendation) : ""}</div>` : ""}
          </td>
          <td width="110" style="padding:18px 0; border-bottom:1px solid #E3E8F0; text-align:right; vertical-align:top; white-space:nowrap;">
            <a href="${detailUrl}" style="background:#071E41; color:#fff; padding:10px 18px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap; display:inline-block;">${buttonLabel}</a>
          </td>
        </tr>`;
    })
    .join("");

  const introLine = subscribed
    ? `<p style="margin:0; font-size:14px; color:#5B6B85;">Here ${jobs.length === 1 ? "is" : "are"} ${jobs.length} new match${jobs.length === 1 ? "" : "es"} for you today:</p>`
    : `<p style="margin:0; font-size:14px; color:#5B6B85;">${jobs.length === 1 ? "This role is" : `These ${jobs.length} roles are`} still waiting for you — subscribe to see who's hiring and apply directly:</p>`;

  const footerLine = subscribed
    ? `<a href="${appBaseUrl}/rook-dashboard.html" style="color:#1463FF; font-size:13px; font-weight:600; text-decoration:none;">See all your matches on ROOK →</a>`
    : `<a href="${appBaseUrl}/rook-pricing.html" style="background:#1463FF; color:#fff; padding:12px 24px; border-radius:6px; font-size:14px; font-weight:700; text-decoration:none; display:inline-block;">Join ROOK to see who's hiring →</a>`;

  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#fff;">
      <div style="background:#071E41; padding:24px; text-align:center;">
        <span style="color:#fff; font-size:20px; font-weight:700; letter-spacing:0.02em;">ROOK</span>
      </div>
      <div style="background:#F5F7FA; padding:20px 24px; text-align:center;">
        <p style="margin:0 0 4px; font-size:15px; color:#071E41;">Hello ${escapeHtml(name || "there")},</p>
        ${introLine}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 24px;">
        ${rows}
      </table>
      <div style="padding:24px; text-align:center;">
        ${footerLine}
      </div>
    </div>`;
}

/**
 * Build and send one candidate's daily digest, if they have qualifying
 * new matches. Returns a status object rather than throwing on "nothing
 * to send" — that's an expected, common outcome, not an error.
 */
async function sendDigestForCandidate(supabase, profile, appBaseUrl) {
  if (!profile.email) return { sent: false, reason: "no_email" };
  if (profile.digest_enabled === false) return { sent: false, reason: "opted_out" };

  // Direct instruction: show the candidate's top matches overall, not
  // just ones newly seen since the last digest - a candidate whose best
  // real opportunities haven't changed day to day shouldn't get an
  // empty inbox just because nothing new happened to appear.
  //
  // Reads from the same precomputed candidate_job_matches table the
  // Dashboard uses, rather than re-scoring every active job (~6,000+)
  // fresh inside this script for every candidate - reuses the work
  // precompute-scores.js already did, stays consistent with what the
  // candidate sees on their Dashboard, and scales the same way the
  // Dashboard's own speed fix did tonight.
  const { data: matchRows, error } = await supabase
    .from("candidate_job_matches")
    .select("*, jobs!inner(*)")
    .eq("candidate_id", profile.id)
    .eq("dismissed", false)
    .eq("jobs.status", "active")
    .eq("jobs.moderation_status", "approved")
    .order("overall_score", { ascending: false })
    // Fetches a larger pool than the final email needs, not just
    // MAX_JOBS_PER_EMAIL directly - foreign jobs get filtered out
    // below, and doing that after an exact-count fetch could leave a
    // digest with fewer than 10 jobs (or fewer than truly available)
    // if any of the top-scored rows happened to be foreign postings.
    .limit(MAX_JOBS_PER_EMAIL * 4);

  if (error) throw new Error(`Could not load matches for digest: ${error.message}`);

  // Explicit, firm instruction: foreign jobs should never show up
  // anywhere, including here - the one deliberate exception to the
  // broader "let all jobs show" rule used everywhere else. A genuine
  // exclusion, not a low score, so it's guaranteed regardless of how
  // scoring itself is tuned.
  const domesticRows = (matchRows || []).filter((row) => !mentionsNonUsCountry(row.jobs?.location_raw, row.jobs?.job_lng, row.jobs?.title_original));

  const scored = domesticRows
    .filter((row) => (row.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE)
    .slice(0, MAX_JOBS_PER_EMAIL)
    .map((row) => ({
      ...row.jobs,
      match: {
        overall_score: row.overall_score,
        excellent_match: row.overall_score >= 85,
        recommendation: row.recommendation,
        reasons: row.strong_match_reasons || row.reasons || [],
        concerns: row.concerns || [],
      },
    }));

  if (scored.length === 0) return { sent: false, reason: "no_qualifying_matches" };

  // Direct instruction: a candidate who finished onboarding but never
  // subscribed should keep getting this daily email, with real jobs
  // and their real match score as the enticement, but the "who's
  // hiring" reveal and the direct job link stay behind the same
  // subscribe gate as everywhere else — reusing redactForNonSubscriber
  // exactly as the Dashboard does, not a separate implementation.
  // Reported directly, a real gap this closes: every recipient
  // previously saw the actual company name and a direct link to the
  // job regardless of subscription status, which gave away the exact
  // thing ROOK charges for.
  const subscribed = isSubscribed(profile);
  const emailJobs = subscribed ? scored : scored.map(redactForNonSubscriber);

  const html = renderDigestHtml({ name: profile.name, jobs: emailJobs, appBaseUrl, subscribed });
  await sendEmail({
    to: profile.email,
    subject: subscribed
      ? `${scored.length} top match${scored.length === 1 ? "" : "es"} on ROOK`
      : `${scored.length} job${scored.length === 1 ? "" : "s"} waiting for you on ROOK — see who's hiring`,
    html,
    // Intentionally no replyTo: this is a no-reply digest. Candidate
    // replies land wherever DIGEST_FROM_EMAIL's mailbox is configured
    // (or nowhere, if it's a pure sending address) rather than Gene's
    // personal inbox.
  });

  return { sent: true, jobCount: scored.length };
}

module.exports = { sendDigestForCandidate, renderDigestHtml };
