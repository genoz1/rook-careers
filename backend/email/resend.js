// Thin Resend API client — no SDK dependency, matches the pattern used
// for the Claude and OpenAI clients elsewhere in this project (raw
// fetch() calls, not a vendor SDK).
//
// Requires RESEND_API_KEY and DIGEST_FROM_EMAIL in the environment.
// DIGEST_FROM_EMAIL must be an address on a domain verified in your
// Resend account — until you verify rookcareers.com (or whatever domain
// you're using) in Resend's dashboard, Resend's own sandbox address
// (onboarding@resend.dev) works for testing but can only send to your
// own verified account email, not real candidates generally.
//
// NOTE: this has not been tested against the live Resend API from the
// environment this was written in — api.resend.com isn't reachable from
// that sandbox. Built to Resend's documented /emails endpoint shape;
// treat the first real send as the real test, same caveat as every
// other external integration in this project.

const REQUEST_TIMEOUT_MS = 20_000;

async function sendEmail({ to, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  if (!process.env.DIGEST_FROM_EMAIL) {
    throw new Error("DIGEST_FROM_EMAIL is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM_EMAIL,
        to: [to],
        subject,
        html,
        // Optional — lets a caller route replies somewhere other than
        // DIGEST_FROM_EMAIL, which has no real inbox behind it (Resend
        // only sends mail, it doesn't host mailboxes). The recruiter
        // application email in jobs.js explicitly tells recruiters to
        // "reply directly to this email to reach the candidate" - that
        // promise is only real if replyTo is actually set to the
        // candidate's address on that specific send.
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Resend request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Resend request failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }

  return res.json();
}

module.exports = { sendEmail };
