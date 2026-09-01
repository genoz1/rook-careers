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

function renderDigestHtml({ name, jobs, appBaseUrl }) {
  const rows = jobs
    .map((job) => {
      const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");
      const analysisUrl = `${appBaseUrl}/rook-job-analysis.html?job=${encodeURIComponent(job.id)}`;
      return `
        <tr>
          <td style="padding:18px 0; border-bottom:1px solid #E3E8F0;">
            <a href="${analysisUrl}" style="color:#1463FF; font-size:16px; font-weight:600; text-decoration:none;">${escapeHtml(job.title_original || "Untitled role")}</a>
            <div style="font-size:13px; color:#5B6B85; margin-top:4px;">
              ${escapeHtml(job.company_name || "")} · ${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}
            </div>
            ${job.match?.overall_score != null ? `<div style="font-size:12px; color:#12B8A6; font-weight:600; margin-top:4px;">${job.match.overall_score}% match${job.match.recommendation ? " · " + escapeHtml(job.match.recommendation) : ""}</div>` : ""}
          </td>
          <td style="padding:18px 0; border-bottom:1px solid #E3E8F0; text-align:right; vertical-align:top;">
            <a href="${analysisUrl}" style="background:#071E41; color:#fff; padding:10px 18px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; display:inline-block;">View Job</a>
          </td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#fff;">
      <div style="background:#071E41; padding:24px; text-align:center;">
        <span style="color:#fff; font-size:20px; font-weight:700; letter-spacing:0.02em;">ROOK</span>
      </div>
      <div style="background:#F5F7FA; padding:20px 24px; text-align:center;">
        <p style="margin:0 0 4px; font-size:15px; color:#071E41;">Hello ${escapeHtml(name || "there")},</p>
        <p style="margin:0; font-size:14px; color:#5B6B85;">Here ${jobs.length === 1 ? "is" : "are"} ${jobs.length} new match${jobs.length === 1 ? "" : "es"} for you today:</p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 24px;">
        ${rows}
      </table>
      <div style="padding:24px; text-align:center;">
        <a href="${appBaseUrl}/rook-dashboard.html" style="color:#1463FF; font-size:13px; font-weight:600; text-decoration:none;">See all your matches on ROOK →</a>
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
    .eq("hard_disqualifier", false)
    .eq("jobs.status", "active")
    .eq("jobs.moderation_status", "approved")
    .order("overall_score", { ascending: false })
    .limit(MAX_JOBS_PER_EMAIL);

  if (error) throw new Error(`Could not load matches for digest: ${error.message}`);

  const scored = (matchRows || [])
    .filter((row) => (row.overall_score ?? -1) >= MIN_SCORE_TO_INCLUDE)
    .map((row) => ({
      ...row.jobs,
      match: {
        overall_score: row.overall_score,
        excellent_match: row.overall_score >= 90,
        recommendation: row.recommendation,
        reasons: row.strong_match_reasons || row.reasons || [],
        concerns: row.concerns || [],
      },
    }));

  if (scored.length === 0) return { sent: false, reason: "no_qualifying_matches" };

  const html = renderDigestHtml({ name: profile.name, jobs: scored, appBaseUrl });
  await sendEmail({
    to: profile.email,
    subject: `${scored.length} top match${scored.length === 1 ? "" : "es"} on ROOK`,
    html,
    // No real inbox behind DIGEST_FROM_EMAIL (Resend sends mail, it
    // doesn't host mailboxes) - route any candidate reply to a real,
    // monitored address instead of it going nowhere.
    replyTo: "eugenezentko@gmail.com",
  });

  return { sent: true, jobCount: scored.length };
}

module.exports = { sendDigestForCandidate, renderDigestHtml };
