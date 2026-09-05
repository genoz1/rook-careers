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
  <!-- Google tag (gtag.js) — these server-rendered pages have no
       existing Google tag to integrate with, unlike the static public/
       pages, so this is a standalone loader rather than an added
       config() call. -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-LDG2CL5Z8R"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-LDG2CL5Z8R');
  </script>
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
    <a href="/" class="logo"><img src="/assets/rook-icon-192.png" alt="ROOK" style="height:22px; width:auto;">ROOK</a>
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
    .select("id, title_original, title_normalized, location_raw, compensation_text, salary_min, salary_max, description_text, date_posted, status, company_name, ai_analysis, remote_status, travel_percentage")
    .eq("id", req.params.id)
    .eq("status", "active")
    .maybeSingle();

  if (error || !job) {
    // Reported via audit: a nonexistent/expired job ID silently showed
    // the plain homepage with no indication anything was wrong - the
    // comment this replaces described falling through to "a normal
    // 404-ish experience" via the SPA catch-all, but that catch-all is
    // just index.html with no logic to recognize this was a failed job
    // lookup specifically. Rendering a real, dedicated response here
    // instead - properly 404-coded (good for crawlers too, not just
    // human visitors) and clear about what happened.
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LDG2CL5Z8R"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-LDG2CL5Z8R');
</script>
<title>Job Not Found | ROOK</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif; background:#F5F7FA; color:#0B1D3A; margin:0; padding:0;}
  .wrap{max-width:560px; margin:0 auto; padding:100px 24px; text-align:center;}
  h1{font-size:26px; margin-bottom:12px;}
  p{color:#5B6B85; font-size:15px; line-height:1.6; margin-bottom:28px;}
  a{display:inline-block; background:#0B1D3A; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;}
</style>
</head>
<body>
  <div class="wrap">
    <h1>This job isn't available anymore</h1>
    <p>It may have been filled, closed by the employer, or the link may be outdated. Browse current openings instead.</p>
    <a href="/rook-browse.html">Browse Open Roles</a>
  </div>
</body>
</html>`);
  }

  const title = job.title_original || job.title_normalized || "Open role";
  const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");

  // Structured teaser built from the AI-extracted job attributes
  // instead of a raw description excerpt. Real bug this replaces:
  // job postings almost always name the employer in their own opening
  // sentence ("Abbott is a global healthcare leader...") — scrubbing
  // that string out of free text is inherently fragile (misses
  // nicknames, abbreviations, slightly different phrasing), so instead
  // of trying to sanitize prose, this shows only categorical data that
  // can never leak identity in the first place: industry, product
  // focus, seniority level, travel expectation. This also sidesteps a
  // second real bug — raw un-decoded HTML entities (literal "&nbsp;"
  // text) sometimes present in ingested description_text, which were
  // showing up as visibly broken text on the page.
  const ai = job.ai_analysis || {};
  const teaserFacts = [];
  if (Array.isArray(ai.required_industries) && ai.required_industries.length) teaserFacts.push(`Industry: ${ai.required_industries[0]}`);
  else if (Array.isArray(ai.preferred_industries) && ai.preferred_industries.length) teaserFacts.push(`Industry: ${ai.preferred_industries[0]}`);
  if (Array.isArray(ai.product_categories) && ai.product_categories.length) teaserFacts.push(`Focus: ${ai.product_categories[0]}`);
  if (ai.seniority_level) teaserFacts.push(`Level: ${ai.seniority_level}`);
  const travelPct = job.travel_percentage ?? ai.travel_percentage;
  if (travelPct != null) teaserFacts.push(`Travel: ${travelPct}%`);
  if (job.remote_status) teaserFacts.push(job.remote_status === "remote" ? "Remote-friendly" : "Field-based");

  const preview = teaserFacts.length > 0
    ? teaserFacts.join(" · ")
    : "Full role details — including responsibilities, requirements, and who's hiring — are visible after you sign up.";

  const canonicalUrl = `${APP_BASE_URL}/jobs/${job.id}`;
  const metaDescription = `${title} — ${job.location_raw || ""}${comp ? " — " + comp : ""}. See the employer and apply on ROOK.`.slice(0, 300);

  // schema.org JobPosting — the markup Google Jobs rich results look
  // for. hiringOrganization is intentionally generic here, same "not
  // revealed until sign-up" principle as everything else on this page —
  // worth knowing that omitting the real employer name may mean this
  // doesn't qualify for the full Google Jobs rich-result treatment,
  // which is a real tradeoff of the gating strategy, not a bug. Basic
  // organic indexing isn't affected by that either way. The
  // "description" field here uses the same safe structured teaser as
  // the visible page, not the raw description_text — that field was
  // leaking the real employer name into structured data even though it
  // was never rendered visibly on the page itself.
  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title,
    description: escapeHtml(preview),
    datePosted: job.date_posted || undefined,
    hiringOrganization: { "@type": "Organization", name: "Confidential — join ROOK to reveal" },
    jobLocation: job.location_raw ? { "@type": "Place", address: job.location_raw } : undefined,
    employmentType: "FULL_TIME",
  };

  const bodyHtml = `
    <div style="background:rgba(20,99,255,0.08); color:var(--royal); display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; padding:6px 12px; border-radius:999px; margin-bottom:16px;">🔒 Employer revealed with ROOK membership</div>
    <h1 style="font-size:28px; margin-bottom:10px;">${escapeHtml(title)}</h1>
    <div style="font-size:14.5px; color:var(--muted); margin-bottom:24px;">${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}${job.date_posted ? " · Posted " + escapeHtml(job.date_posted) : ""}</div>
    <div style="background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:24px; margin-bottom:24px; font-size:14.5px; line-height:1.7; color:var(--navy);">
      ${escapeHtml(preview)}
      <div style="margin-top:16px; padding-top:16px; border-top:1px dashed var(--border); color:var(--muted); font-style:italic;">ROOK members see the employer, full opportunity details, direct application link, and personalized match score.</div>
    </div>
    <div style="background:var(--navy); border-radius:var(--radius); padding:28px 24px; text-align:center;">
      <h3 style="color:#fff; font-size:19px; margin-bottom:8px;">Ready to see who's hiring?</h3>
      <p style="color:#B9C4DB; font-size:13.5px; margin-bottom:14px;">See the employer, apply directly, and get this job — and every other opportunity — scored against your experience.</p>
      <div style="color:#fff; font-size:15px; font-weight:700; margin-bottom:18px;">$29/month · Cancel anytime</div>
      <a href="/rook-login.html" class="btn btn-primary">Get Started</a>
      <div style="color:#8B96AB; font-size:12px; margin-top:10px;">One membership. Full ROOK access.</div>
    </div>
    <div style="text-align:center; margin-top:20px;"><a href="/rook-browse.html" style="color:var(--royal); font-size:13px; font-weight:600;">← Back to all open roles</a></div>
  `;

  res.send(pageShell({ title: `${title} — ROOK`, description: metaDescription, canonicalUrl, bodyHtml, jsonLd }));
});

// Real, curated set of job categories for server-rendered landing
// pages — the actual SEO purpose of this whole route. Each one targets
// a specific, meaningfully-searched phrase with its own genuinely
// unique title, meta description, and real filtered job content —
// deliberately NOT the same shared page with a query-string filter,
// since a client-rendered page whose title/meta never change per
// filter would likely be seen by search engines as one page, not many,
// defeating the point. searchTerms are matched against title and
// description text (case-insensitive, OR'd together) to decide which
// real jobs appear on each category page.
const CATEGORIES = {
  "medical-sales-jobs": { label: "Medical Sales Jobs", searchTerms: ["medical sales", "medical device sales", "healthcare sales"] },
  "pharmaceutical-sales-jobs": { label: "Pharmaceutical Sales Jobs", searchTerms: ["pharmaceutical", "pharma sales"] },
  "medical-device-sales-jobs": { label: "Medical Device Sales Jobs", searchTerms: ["medical device", "device sales", "surgical device"] },
  "diagnostics-sales-jobs": { label: "Diagnostics & Laboratory Sales Jobs", searchTerms: ["diagnostic", "laboratory sales", "lab sales"] },
  "veterinary-sales-jobs": { label: "Veterinary Sales Jobs", searchTerms: ["veterinary", "vet sales"] },
  "animal-health-sales-jobs": { label: "Animal Health Sales Jobs", searchTerms: ["animal health"] },
  "territory-sales-manager-jobs": { label: "Territory Sales Manager Jobs", searchTerms: ["territory manager", "territory sales", "territory representative"] },
  "key-account-manager-jobs": { label: "Key Account Manager Jobs", searchTerms: ["key account manager", "key account executive"] },
  "capital-equipment-sales-jobs": { label: "Capital Equipment Sales Jobs", searchTerms: ["capital equipment"] },
};

// GET /jobs/category/:slug — a real, server-rendered landing page per
// category, listing genuinely matching real jobs (title, location,
// compensation only — no description snippet here at all, since
// scrubbing a company name out of raw description text has already
// proven to miss abbreviated/shortened forms of a company's name once
// already; a plain list of real title/location/comp carries zero of
// that risk while still being genuinely useful).
router.get("/jobs/category/:slug", async (req, res, next) => {
  const category = CATEGORIES[req.params.slug];
  if (!category || !isConfigured) return next();

  const orFilter = category.searchTerms
    .flatMap((term) => [`title_original.ilike.%${term}%`, `description_text.ilike.%${term}%`])
    .join(",");

  const { data: jobs } = await supabaseAnon
    .from("jobs")
    .select("id, title_original, location_raw, compensation_text, salary_min, salary_max, date_posted")
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .or(orFilter)
    .order("date_posted", { ascending: false })
    .limit(40);

  const jobRows = jobs || [];
  const canonicalUrl = `${APP_BASE_URL}/jobs/category/${req.params.slug}`;
  const metaDescription = `Browse ${jobRows.length} real, currently open ${category.label.toLowerCase()} on ROOK — sourced directly from employer career sites. Sign up to see the employer and apply.`.slice(0, 300);

  const otherCategories = Object.entries(CATEGORIES).filter(([slug]) => slug !== req.params.slug);

  const bodyHtml = `
    <h1 style="font-size:28px; margin-bottom:10px;">${escapeHtml(category.label)}</h1>
    <p style="color:var(--muted); font-size:14.5px; margin-bottom:28px;">${jobRows.length} real, currently open role${jobRows.length === 1 ? "" : "s"} — pulled directly from employer career sites, not a stale aggregator.</p>
    ${jobRows.length === 0 ? `<div style="color:var(--muted); font-size:14.5px; padding:40px 0; text-align:center;">No open roles in this category right now — check back soon, or <a href="/rook-browse.html" style="color:var(--royal); font-weight:600;">browse all open roles</a>.</div>` : ""}
    ${jobRows.map((job) => {
      const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");
      return `
      <a href="/jobs/${escapeHtml(job.id)}" style="display:block; background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; margin-bottom:12px;">
        <div style="font-weight:700; font-size:15px; margin-bottom:4px;">${escapeHtml(job.title_original || "Untitled role")}</div>
        <div style="color:var(--muted); font-size:13px;">${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}</div>
      </a>`;
    }).join("")}
    <div style="background:var(--navy); border-radius:var(--radius); padding:28px 24px; text-align:center; margin-top:32px;">
      <h3 style="color:#fff; font-size:19px; margin-bottom:8px;">Ready to see who's hiring?</h3>
      <p style="color:#B9C4DB; font-size:13.5px; margin-bottom:14px;">See the employer, apply directly, and get every role scored against your experience.</p>
      <div style="color:#fff; font-size:15px; font-weight:700; margin-bottom:18px;">$29/month · Cancel anytime</div>
      <a href="/rook-login.html" class="btn btn-primary">Get Started</a>
      <div style="color:#8B96AB; font-size:12px; margin-top:10px;">One membership. Full ROOK access.</div>
    </div>
    <div style="margin-top:36px;">
      <div style="font-size:12.5px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:12px;">Browse other categories</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        ${otherCategories.map(([slug, c]) => `<a href="/jobs/category/${slug}" style="font-size:13px; color:var(--royal); background:rgba(20,99,255,0.08); padding:7px 14px; border-radius:99px; font-weight:600;">${escapeHtml(c.label)}</a>`).join("")}
      </div>
    </div>
  `;

  res.send(pageShell({ title: `${category.label} — ROOK`, description: metaDescription, canonicalUrl, bodyHtml }));
});

// GET /sitemap.xml — lists the homepage, the public browse page, and
// every currently-active job's real crawlable URL. Regenerated on every
// request rather than cached as a static file, since the job list
// changes continuously via the scheduled ingestion job.
router.get("/sitemap.xml", async (req, res) => {
  const staticUrls = [
    `${APP_BASE_URL}/`,
    `${APP_BASE_URL}/rook-browse.html`,
    `${APP_BASE_URL}/rook-about.html`,
    `${APP_BASE_URL}/rook-pricing.html`,
    `${APP_BASE_URL}/rook-employers.html`,
    ...Object.keys(CATEGORIES).map((slug) => `${APP_BASE_URL}/jobs/category/${slug}`),
  ];

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
