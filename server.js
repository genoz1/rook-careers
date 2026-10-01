require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const publicSeo = require("./backend/publicSeo");
app.use(publicSeo.headers);
app.use(require('./backend/socialShortLinks').createRouter());
app.get("/index.html", (req,res) => res.redirect(301,"/" + (req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "")));
const PORT = process.env.PORT || 8080;

// Safety net: on Node 18+, an unhandled promise rejection ANYWHERE in the
// app crashes the entire process by default — not just the one request
// that caused it. That's what took the server down when a single
// unprotected Supabase call failed in the /apply route (see jobs.js).
// That specific spot is now fixed, but this catch-all means the same
// class of mistake anywhere else in the codebase logs an error instead
// of killing the whole site for every candidate/recruiter using it at
// that moment.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server stayed up):", reason);
});

// Stripe webhooks need the RAW body to verify the signature, so this
// route is wired BEFORE express.json() and given raw() explicitly.
const stripeRoutes = require("./backend/routes/stripe");
app.use(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" })
);
// All other Stripe routes need normal JSON parsing
app.use(express.json());
app.use("/api", stripeRoutes);
app.use("/api/v7", require("./backend/routes/onboardingV7"));
app.use("/api/v8", require("./backend/routes/onboardingV8"));
app.use("/api/v9", require("./backend/routes/onboardingV9"));

app.use("/api", require("./backend/routes/profile"));
app.use("/api", require("./backend/routes/jobs"));
app.use("/api", require("./backend/routes/admin"));
app.use("/api", require("./backend/routes/applications"));
app.use("/api", require("./backend/routes/applicationPackage"));
app.use("/api", require("./backend/routes/careerIntelligence"));
app.use("/api", require("./backend/routes/geocode"));
app.use("/api", require("./backend/routes/recruiterPostings"));
app.use("/api", require("./backend/routes/automation"));
app.use("/api", require("./backend/admanager/conversions"));

// Keep legacy ad URLs and links opened under /medical-sales/ on real pages.
// Preserve the original query string verbatim for Google Ads attribution.
app.get("/medical-sales/free-trial", (req, res) => {
  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
  res.set("Cache-Control", "no-store");
  return res.redirect(302, "/rook-onboarding-v8.html" + query);
});
app.get("/medical-sales/:page", (req, res, next) => {
  const page = req.params.page;
  if (!/^rook-[a-z0-9-]+\.html$/.test(page) ||
      !require("fs").existsSync(path.join(__dirname, "public", page))) return next();
  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
  res.set("Cache-Control", "no-store");
  if (/^rook-onboarding(?:-v[2-7])?\.html$/.test(page) &&
      !(page === "rook-onboarding-v2.html" && (req.query.ob === "resume_upload" || req.query.edit === "preferences"))) {
    return res.redirect(302, "/rook-onboarding-v8.html" + query);
  }
  return res.redirect(302, "/" + page + query);
});

// Server-rendered public pages (real per-job SEO meta tags + sitemap) —
// registered before the static file server and the SPA catch-all below,
// since /jobs/:id and /sitemap.xml aren't real files in /public.
app.use(require("./backend/resources/routes").createRouter());
app.get('/medreps-alternative', (req,res) => {
  res.set('Cache-Control','no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname,'public','medreps-alternative.html'));
});
app.get('/meta/v9', (req,res) => {
  res.set('Cache-Control','no-cache, no-store, must-revalidate');
  res.set('X-Robots-Tag','noindex, follow');
  const queryStart=req.originalUrl.indexOf('?');
  const query=queryStart===-1?'':req.originalUrl.slice(queryStart);
  res.redirect(302,'/rook-onboarding-v9.html'+query);
});
app.use("/", require("./backend/routes/publicPages"));

// Static frontend (the UI prototype pages).
// HTML files must revalidate on every request — no stale cached
// layouts served after a deployment. JS/CSS/images can be cached
// safely since they're content-addressed by filename.
// All legacy onboarding entry URLs go directly to V8. Keep the original
// query string for ad attribution and avoid a cached permanent redirect.
app.get(["/rook-onboarding.html", ...[2, 3, 4, 5, 6, 7].map(v => `/rook-onboarding-v${v}.html`)], (req, res) => {
  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
  res.set("Cache-Control", "no-store");
  if (req.path === "/rook-onboarding-v2.html" && (req.query.ob === "resume_upload" || req.query.edit === "preferences")) {
    const params = new URLSearchParams(query.slice(1));
    params.set("rook_v8", "1");
    const destination = req.query.ob === "resume_upload" ? "/rook-resume.html" : "/rook-settings.html";
    return res.redirect(302, destination + "?" + params.toString());
  }
  return res.redirect(302, "/rook-onboarding-v8.html" + query);
});

// Retire the legacy card-first acquisition endpoints. Existing members use
// member pages; prospective users preserve attribution and enter the current
// verified-email, no-card V8 flow instead.
app.get(["/rook-checkout.html", "/rook-checkout-v7.html", "/rook-onboarding-v6-signup.html", "/rook-onboarding-v7-signup.html"], (req, res) => {
  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
  res.set("Cache-Control", "no-store");
  return res.redirect(302, "/rook-onboarding-v8.html" + query);
});

// Serve rook-config.js dynamically so STRIPE_PUBLISHABLE_KEY is injected
// from env without being hardcoded in the static file.
app.get("/rook-config.js", (req, res) => {
  res.type("application/javascript");
  res.send(`window.ROOK_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(process.env.SUPABASE_URL || "")},
  SUPABASE_ANON_KEY: ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")},
  API_BASE: "/api",
  STRIPE_PUBLISHABLE_KEY: ${JSON.stringify(process.env.STRIPE_PUBLISHABLE_KEY || "")},
};`);
});

app.use(publicSeo.pages);
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    publicSeo.staticHeaders(res,filePath);
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  },
}));

app.get("*", (req, res) => {
  res.status(404).set("X-Robots-Tag","noindex").send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page Not Found | ROOK</title></head><body><main><h1>Page not found</h1><p>This address is not available.</p><a href="/">ROOK home</a> · <a href="/jobs">Browse job previews</a></main></body></html>');
});

app.listen(PORT, () => {
  console.log(`ROOK server running on port ${PORT}`);
  require('./backend/ingestionWatchdog').startIngestionWatchdog();
  require('./backend/resources/worker').start();
  // Pre-warm the active-jobs cache 5 s after boot so the first onboarding
  // preview request hits the cache instead of waiting 40+ s for a cold fetch.
  const { fetchActiveJobs } = require("./backend/scoring/precompute");
  const { createClient } = require("@supabase/supabase-js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    require('./backend/repairCitySuffixCoordinates').repairCitySuffixCoordinates(supabaseAdmin)
      .then(result => console.log('[location-repair]', JSON.stringify(result)))
      .catch(err => console.error('[location-repair] failed:', err.message));
    setTimeout(() => {
      fetchActiveJobs(supabaseAdmin)
        .then(jobs => console.log(`[boot] active-jobs cache warmed: ${jobs.length} jobs`))
        .catch(err => console.warn(`[boot] cache warm failed: ${err.message}`));
    }, 5000);
  }
});
