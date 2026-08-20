// Server-rendered public pages — the partial-reveal job detail page and
// a dynamic sitemap. These exist as real Express routes (not static
// files) specifically so the HTML that comes back on the FIRST request
// already has real, per-job <title>/<meta> tags and visible content —
// search engines and link-preview bots (Slack, Facebook, Twitter) mostly
// don't execute JavaScript, so a page that only fills in real content
// via a client-side fetch() after load is functionally invisible to
// them. Every other ROOK page in this project is a static file that
// fetches its own data client-side; this is deliberately different,
// because these two pages are the ones meant to be found by search
// engines and shared as links, not just used by people already signed in.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabaseAnon = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

const APP_BASE_URL = process.env.PUBLIC_APP_URL || "https://seashell-app-hbjuo.ondigitalocean.app";

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Shared page chrome (nav, footer, styles) so the job page and sitemap-
// adjacent pages look like the rest of ROOK rather than a bare document.
function pageShell({ title, description, canonicalUrl, ogImage, bodyHtml, jsonLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  ${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ""}
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="/assets/favicon.ico" sizes="any">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
  <style>
    :root{ --navy:#071E41; --royal:#1463FF; --teal:#12B8A6; --gray:#F5F7FA; --white:#FFFFFF; --muted:#5B6B85; --border:#E3E8F0; --radius:14px; --font-display:'Space Grotesk', sans-serif; --font-body:'Inter', sans-serif; }
    *{box-sizing:border-box; margin:0; padding:0;}
    body{font-family:var(--font-body); color:var(--navy); background:var(--gray); -webkit-font-smoothing:antialiased;}
    h1,h2,h3,h4{font-family:var(--font-display); letter-spacing:-0.01em;}
    a{color:inherit; text-decoration:none;}
    .btn{display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:12px 22px; border-radius:999px; font-size:14px; font-weight:600; cursor:pointer; border:none;}
    .btn-primary{background:var(--royal); color:#fff;}
    .btn-outline{background:#fff; color:var(--navy); border:1px solid var(--border);}
    .topbar{background:var(--navy); padding:16px 32px; display:flex; align-items:center; justify-content:space-between;}
    .topbar .logo{font-family:var(--font-display); font-weight:700; font-size:18px; color:#fff; display:flex; align-items:center; gap:8px;}
    .container{max-width:720px; margin:0 auto; padding:40px 24px 60px;}
  </style>
</head>
<body>
  <div class="topbar">
    <a href="/" class="logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>ROOK</a>
    <a href="/rook-login.html" class="btn btn-outline">Log In</a>
  </div>
  <div class="container">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// GET /jobs/:id — the partial-reveal public job page. Title, location,
// compensation, and a description preview are real and visible; company
// name and the real apply link stay gated behind sign-up, same fields
// withheld as the anonymous JSON API teaser in backend/routes/jobs.js.
router.get("/jobs/:id", async (req, res, next) => {
  if (!isConfigured) return next(); // falls through to the SPA catch-all if Supabase isn't set up yet

  const { data: job, error } = await supabaseAnon
    .from("jobs")
    .select("id, title_original, title_normalized, location_raw, compensation_text, salary_min, salary_max, description_text, date_posted, status")
    .eq("id", req.params.id)
    .eq("status", "active")
    .maybeSingle();

  if (error || !job) return next(); // let the SPA catch-all show a normal 404-ish experience

  const title = job.title_original || job.title_normalized || "Open role";
  const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");
  const preview = (job.description_text || "").slice(0, 400);
  const canonicalUrl = `${APP_BASE_URL}/jobs/${job.id}`;
  const metaDescription = `${title} — ${job.location_raw || ""}${comp ? " — " + comp : ""}. See the employer and apply on ROOK.`.slice(0, 300);

  // schema.org JobPosting — the markup Google Jobs rich results look
  // for. hiringOrganization is intentionally generic here, same "not
  // revealed until sign-up" principle as everything else on this page —
  // worth knowing that omitting the real employer name may mean this
  // doesn't qualify for the full Google Jobs rich-result treatment,
  // which is a real tradeoff of the gating strategy, not a bug. Basic
  // organic indexing isn't affected by that either way.
  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title,
    description: escapeHtml(job.description_text || title),
    datePosted: job.date_posted || undefined,
    hiringOrganization: { "@type": "Organization", name: "Confidential — join ROOK to reveal" },
    jobLocation: job.location_raw ? { "@type": "Place", address: job.location_raw } : undefined,
    employmentType: "FULL_TIME",
  };

  const bodyHtml = `
    <div style="background:rgba(20,99,255,0.08); color:var(--royal); display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; padding:6px 12px; border-radius:999px; margin-bottom:16px;">🔒 Employer hidden — sign up to reveal</div>
    <h1 style="font-size:28px; margin-bottom:10px;">${escapeHtml(title)}</h1>
    <div style="font-size:14.5px; color:var(--muted); margin-bottom:24px;">${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}${job.date_posted ? " · Posted " + escapeHtml(job.date_posted) : ""}</div>
    <div style="background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:24px; margin-bottom:24px; font-size:14.5px; line-height:1.7; color:var(--navy);">
      ${escapeHtml(preview)}${preview.length >= 400 ? "…" : ""}
      <div style="margin-top:16px; padding-top:16px; border-top:1px dashed var(--border); color:var(--muted); font-style:italic;">The rest of this posting — including who's hiring and how to apply — is visible after you sign up free.</div>
    </div>
    <div style="background:var(--navy); border-radius:var(--radius); padding:28px 24px; text-align:center;">
      <h3 style="color:#fff; font-size:19px; margin-bottom:8px;">Ready to see who's hiring?</h3>
      <p style="color:#B9C4DB; font-size:13.5px; margin-bottom:18px;">Free to join. See the employer, apply directly, and get this job (and every other one) scored against your real background.</p>
      <a href="/rook-login.html" class="btn btn-primary">Get Started Free</a>
    </div>
    <div style="text-align:center; margin-top:20px;"><a href="/rook-browse.html" style="color:var(--royal); font-size:13px; font-weight:600;">← Back to all open roles</a></div>
  `;

  res.send(pageShell({ title: `${title} — ROOK`, description: metaDescription, canonicalUrl, bodyHtml, jsonLd }));
});

// GET /sitemap.xml — lists the homepage, the public browse page, and
// every currently-active job's real crawlable URL. Regenerated on every
// request rather than cached as a static file, since the job list
// changes continuously via the scheduled ingestion job.
router.get("/sitemap.xml", async (req, res) => {
  const staticUrls = [`${APP_BASE_URL}/`, `${APP_BASE_URL}/rook-browse.html`];

  let jobUrls = [];
  if (isConfigured) {
    const { data: jobs } = await supabaseAnon
      .from("jobs")
      .select("id, last_seen_at")
      .eq("status", "active")
      .limit(5000);
    jobUrls = (jobs || []).map((j) => ({ url: `${APP_BASE_URL}/jobs/${j.id}`, lastmod: j.last_seen_at }));
  }

  const urlEntries = [
    ...staticUrls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`),
    ...jobUrls.map(
      (j) => `<url><loc>${escapeHtml(j.url)}</loc>${j.lastmod ? `<lastmod>${new Date(j.lastmod).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`
    ),
  ].join("\n");

  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`);
});

module.exports = router;
