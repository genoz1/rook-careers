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
const { getTrialPeriodDays } = require("../routes/stripe");
const { isUsEligibleJob } = require("../jobEligibility");

const router = express.Router();
const {project,publicPreview} = require('../pretrialProjection');
router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const APP_BASE_URL = (process.env.PUBLIC_APP_URL || "https://rookcareers.com").replace(/\/$/, "");
const {createInventoryLoader} = require("../seoInventory");
const {createCollectionHandler, createRelatedArticleLoader, hasFilters} = require("../seoCollections");
const loadSeoInventory = createInventoryLoader(supabaseAnon);

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Extract "City, ST" from raw location strings like
// "Tampa, Florida, United States" or "Tampa, FL, US"
function shortLocation(raw) {
  if (!raw) return null;
  const STATE_ABBR = { Florida:"FL",Texas:"TX",California:"CA","New York":"NY",Ohio:"OH",Illinois:"IL",Georgia:"GA","North Carolina":"NC",Michigan:"MI",Pennsylvania:"PA",Tennessee:"TN",Virginia:"VA",Washington:"WA",Massachusetts:"MA",Arizona:"AZ",Colorado:"CO",Minnesota:"MN","New Jersey":"NJ",Indiana:"IN",Missouri:"MO",Maryland:"MD",Wisconsin:"WI",Connecticut:"CT",Nevada:"NV",Louisiana:"LA",Alabama:"AL","South Carolina":"SC",Kentucky:"KY",Oregon:"OR",Oklahoma:"OK","New Mexico":"NM",Utah:"UT",Iowa:"IA",Arkansas:"AR",Kansas:"KS",Nebraska:"NE","West Virginia":"WV",Idaho:"ID","New Hampshire":"NH",Maine:"ME",Montana:"MT",Delaware:"DE","North Dakota":"ND","South Dakota":"SD",Alaska:"AK",Vermont:"VT",Wyoming:"WY","Rhode Island":"RI",Hawaii:"HI",Mississippi:"MS" };
  const parts = raw.split(",").map(s => s.trim()).filter(s => s && !/^(United States?|US|USA)$/i.test(s));
  if (parts.length === 0) return null;
  const city = parts[0];
  const stateRaw = parts[1] || "";
  if (/^[A-Z]{2}$/.test(stateRaw)) return `${city}, ${stateRaw}`;
  const abbr = STATE_ABBR[stateRaw];
  if (abbr) return `${city}, ${abbr}`;
  if (stateRaw.length > 0 && stateRaw.length <= 20) return `${city}, ${stateRaw}`;
  return city;
}

// Shared page chrome (nav, footer, styles) so the job page and sitemap-
// adjacent pages look like the rest of ROOK rather than a bare document.
function pageShell({ title, description, canonicalUrl, ogImage, bodyHtml, jsonLd, jobId, noindex = false }) {
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
  ${noindex ? '<meta name="robots" content="noindex, follow">' : ""}
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
    <a href="/rook-login.html?return=${encodeURIComponent(canonicalUrl)}" class="btn btn-outline">Log In</a>
  </div>
  <div class="container">
    ${bodyHtml}
  </div>
  <script src="/rook-config.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
  <script src="/rook-auth.js"></script>
  ${jobId ? '' : '<script src="/rook-access.js"></script>'}
  ${jobId ? `<script>
  (async () => {
    try {
      const sb = window.supabase.createClient(
        window.ROOK_CONFIG.SUPABASE_URL,
        window.ROOK_CONFIG.SUPABASE_ANON_KEY
      );
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const res = await fetch('/api/profile', {
        headers: { Authorization: 'Bearer ' + session.access_token }
      });
      if (!res.ok) return;
      const profile = await res.json();
      const status = profile.subscription_status;
      if (rookHasFullAccess(profile)) {
        window.location.replace('/rook-job-analysis.html?job=${escapeHtml(jobId)}');
      }
    } catch (_) {}
  })();
  </script>` : ''}
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
    .select("id, employment_type, recruiter_company, source_type, city, title_original, title_normalized, location_raw, location_evidence, compensation_text, salary_min, salary_max, description_text, date_posted, status, moderation_status, company_name, ai_analysis, remote_status, travel_percentage, job_lat, job_lng, state")
    .eq("id", req.params.id)
    .eq("status", "active").eq("moderation_status", "approved")
    .maybeSingle();

  // Direct instruction, prompted by a real incident: a Wuhan, China
  // posting was indexed by Google via this exact page. This route had
  // no eligibility check at all — any active job, regardless of
  // country, got a full public page. Treated identically to "not
  // found" rather than a distinct error: this never reveals to a
  // visitor or a crawler that ROOK has non-US postings internally, and
  // it means a job that later gets corrected (e.g. once re-ingested
  // cleanly) becomes visible again automatically, with no special
  // handling needed.
  if (error && error.code !== "22P02") return res.status(503).set("Retry-After", "60").send("Job preview temporarily unavailable.");
  if (!job || !isUsEligibleJob(job)) {
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

  const safe = publicPreview(job);
  const title = safe.title;
  const canonicalUrl = `${APP_BASE_URL}/jobs/${job.id}`;
  const description = safe.summary;
  const query = new URLSearchParams();
  for (const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','referral','gclid','gbraid','wbraid']) {
    if (typeof req.query[key] === 'string') query.set(key, req.query[key].slice(0,200));
  }
  query.set('job', job.id);
  const facts = [safe.location, ...safe.industry_classification.labels, safe.employment_type, safe.salary].filter(Boolean);
  const bodyHtml = `<h1 style="font-size:28px;margin-bottom:20px;overflow-wrap:anywhere">${escapeHtml(title)}</h1>
    <p style="line-height:1.7;margin-bottom:24px">${facts.map(escapeHtml).join(' · ')}</p>
    <section style="background:white;border:1px solid var(--border);padding:24px;border-radius:14px">
      <h2 style="font-size:18px;margin-bottom:12px">Employer: 🔒 Hidden until free trial</h2>
      <p style="line-height:1.7;margin-bottom:20px">${escapeHtml(safe.summary)}</p>
      <p style="line-height:1.7;margin-bottom:20px">Want to see the employer, complete job description and application link?</p>
      <a class="btn btn-primary" href="/rook-onboarding-v8.html?${escapeHtml(query.toString())}">Try ROOK Today for Free</a>
      <p style="font-size:13px;margin-top:16px">24 hours of full access. No credit card required.</p>
    </section><script src="/rook-attribution.js"></script>`;
  res.send(pageShell({title:`${title} — ROOK`,description,canonicalUrl,bodyHtml,jobId:job.id,
    jsonLd:{'@context':'https://schema.org','@type':'WebPage',name:title,description,url:canonicalUrl}}));

});

// All existing industry and role categories reuse the active eligible inventory.
// Employer identity and full descriptions remain behind the existing preview boundary.
const collectionHandler = createCollectionHandler({loadInventory:loadSeoInventory,loadRelatedArticles:createRelatedArticleLoader(supabaseAnon),pageShell,escapeHtml,baseUrl:APP_BASE_URL});
router.get("/jobs/category/animal-health-sales-jobs", (req,res) => res.redirect(301,"/jobs/category/veterinary-sales-jobs"));
router.get("/jobs/category/:slug/:state", collectionHandler);
router.get("/jobs/category/:slug", collectionHandler);

// A crawlable directory with ordinary links and pagination in the first HTML
// response. Select only fields already visible in anonymous job previews.
router.get("/jobs", async (req, res) => {
  if (!isConfigured) return res.status(503).set("Retry-After", "300").send("Job directory temporarily unavailable.");
  const pageValue = req.query.page === undefined ? "1" : req.query.page;
  if (typeof pageValue !== "string" || !/^[1-9]\d*$/.test(pageValue)) return res.status(404).send("Page not found.");
  const page = Number(pageValue);
  const pageSize = 100;
  if (!Number.isSafeInteger(page * pageSize)) return res.status(404).send("Page not found.");
  try {
    const { data, error } = await supabaseAnon.from("jobs")
      .select("id, title_original, title_normalized, location_raw, location_evidence, job_lat, job_lng, state, ai_analysis, category, sales_type, territory, remote_status, date_posted, first_seen_at")
      .eq("status", "active").eq("moderation_status", "approved")
      .order("id", { ascending: true })
      .range((page - 1) * pageSize, page * pageSize);
    if (error || !Array.isArray(data)) throw new Error("Directory query failed");
    if (!data.length && page > 1) return res.status(404).send("Page not found.");
    const eligibleData = data.filter(isUsEligibleJob);
    const pageUrl = (number) => number === 1 ? "/jobs" : `/jobs?page=${number}`;
    const bodyHtml = `
      <h1 style="font-size:28px;margin-bottom:16px;">Medical sales job previews${page > 1 ? ` — page ${page}` : ""}</h1>
      <p style="line-height:1.7;margin-bottom:24px;">Explore current opportunities by broad industry and role. ROOK membership unlocks job titles, employers, full details and application links.</p>
      <p style="margin-bottom:24px;"><a href="/rook-browse.html" style="color:var(--royal);">Find roles near your ZIP code</a></p>
      ${eligibleData.slice(0, pageSize).map(job => `<a href="/jobs/${escapeHtml(job.id)}" style="display:block;background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;"><h2 style="font-size:17px;margin-bottom:6px;">${escapeHtml(project(job).industry_classification.labels.join(' · ') || 'Sales opportunity')}</h2><p style="color:var(--muted);">${escapeHtml([project(job).role_type,project(job).territory_type,project(job).freshness_label].filter(Boolean).join(' · '))}</p></a>`).join("") || "<p>No open roles right now. Please check back soon.</p>"}
      <nav aria-label="Job directory pages" style="display:flex;justify-content:space-between;gap:16px;margin-top:24px;">
        ${page > 1 ? `<a href="${pageUrl(page - 1)}" class="btn btn-outline">Previous page</a>` : ""}
        ${data.length > pageSize ? `<a href="${pageUrl(page + 1)}" class="btn btn-outline">Next page</a>` : ""}
      </nav>`;
    return res.send(pageShell({ title: `Medical Sales Job Previews${page > 1 ? ` — Page ${page}` : ""} — ROOK`, description: "Explore current medical sales opportunities. Unlock job titles, employer details and personalized matching with ROOK membership.", canonicalUrl: `${APP_BASE_URL}${pageUrl(page)}`, bodyHtml, noindex:hasFilters(req.query) }));
  } catch (_) {
    return res.status(503).set("Retry-After", "300").send("Job directory temporarily unavailable.");
  }
});

// GET /sitemap.xml — lists the homepage, the public browse page, and
// every currently-active job's real crawlable URL. Regenerated on every
// request rather than cached as a static file, since the job list
// changes continuously via the scheduled ingestion job.
router.get("/sitemap.xml", async (req, res) => {
  const staticUrls = [
    `${APP_BASE_URL}/`,
    `${APP_BASE_URL}/jobs`,
    `${APP_BASE_URL}/resources/`,
    `${APP_BASE_URL}/medreps-alternative`,
    `${APP_BASE_URL}/rook-browse.html`,
    `${APP_BASE_URL}/rook-about.html`,
    `${APP_BASE_URL}/rook-pricing.html`,
    `${APP_BASE_URL}/rook-employers.html`,
  ];

  if (!isConfigured) return res.status(503).set("Retry-After", "300").send("Sitemap temporarily unavailable.");
  const jobUrls = [];
  try {
    const collections = await loadSeoInventory();
    staticUrls.push(...Object.values(collections).filter(c=>c.qualified).map(c=>APP_BASE_URL+c.path));
    // PostgREST can cap a single response even when limit(5000) is requested.
    // Use small, ordered pages and advance by the number actually returned.
    let offset = 0;
    while (true) {
      const { data: jobs, error } = await supabaseAnon.from("jobs")
        .select("id, job_lat, job_lng, state, location_raw, location_evidence").eq("status", "active").eq("moderation_status", "approved")
        .order("id", { ascending: true }).range(offset, offset + 499);
      if (error || !Array.isArray(jobs)) throw new Error("Sitemap query failed");
      if (!jobs.length) break;
      jobUrls.push(...jobs.filter(isUsEligibleJob).map(j => `${APP_BASE_URL}/jobs/${j.id}`));
      if (jobUrls.length + staticUrls.length > 50000) throw new Error("Sitemap requires splitting");
      offset += jobs.length;
    }
    // Only committed, published Resources articles; topics still in the queue
    // (or rejected) never become sitemap entries. Read every page on each request.
    offset = 0;
    const now = new Date().toISOString();
    while (true) {
      const { data: articles, error } = await supabaseAnon.from("resource_articles")
        .select("slug, resource_topics!inner(status)").eq("resource_topics.status", "published")
        .lte("published_at", now).order("slug", { ascending: true }).range(offset, offset + 499);
      if (error || !Array.isArray(articles)) throw new Error("Resources sitemap query failed");
      if (!articles.length) break;
      staticUrls.push(...articles.map(a => `${APP_BASE_URL}/resources/${a.slug}/`));
      if (jobUrls.length + staticUrls.length > 50000) throw new Error("Sitemap requires splitting");
      offset += articles.length;
    }
  } catch (_) {
    // Never publish a successful but empty/partial sitemap during an outage.
    return res.status(503).set("Retry-After", "300").send("Sitemap temporarily unavailable.");
  }

  // last_seen_at records ingestion checks, not significant page changes.
  // Omit lastmod until a reliable content-modification timestamp is available.
  const urlEntries = [
    ...staticUrls, ...jobUrls,
  ].map(url => `<url><loc>${escapeHtml(url)}</loc></url>`).join("\n");

  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`);
});

module.exports = router;
