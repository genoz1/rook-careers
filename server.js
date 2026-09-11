require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
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
app.use("/api", stripeRoutes);

// Everything else gets normal JSON body parsing.
app.use(express.json());

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

// Server-rendered public pages (real per-job SEO meta tags + sitemap) —
// registered before the static file server and the SPA catch-all below,
// since /jobs/:id and /sitemap.xml aren't real files in /public.
app.use("/", require("./backend/routes/publicPages"));

// Static frontend (the UI prototype pages).
// HTML files must revalidate on every request — no stale cached
// layouts served after a deployment. JS/CSS/images can be cached
// safely since they're content-addressed by filename.
// v4 is the current onboarding — redirect earlier versions to it
// Using 302 (temporary) not 301 (permanent) so browsers don't cache the redirect
app.get("/rook-onboarding.html", (req, res) => {
  const qs = Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
  res.redirect(302, "/rook-onboarding-v4.html" + qs);
});
// v5 was created by a previous session — redirect it to v4
app.get("/rook-onboarding-v5.html", (req, res) => {
  const qs = Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
  res.redirect(302, "/rook-onboarding-v4.html" + qs);
});
app.get("/rook-onboarding-v4.html", (req, res) => {
  return res.sendFile(require("path").join(__dirname, "public", "rook-onboarding-v4.html"));
});
app.get("/rook-onboarding-v2.html", (req, res) => {
  const ob   = req.query.ob;
  const edit = req.query.edit;
  if (ob === "v2_return" || ob === "resume_upload" || edit === "preferences") {
    return res.sendFile(path.join(__dirname, "public", "rook-onboarding-v2.html"));
  }
  const qs = Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
  res.redirect(302, "/rook-onboarding-v4.html" + qs);
});
app.get("/rook-onboarding-v3.html", (req, res) => {
  const ob = req.query.ob;
  if (ob === "v3_verified") {
    return res.sendFile(path.join(__dirname, "public", "rook-onboarding-v3.html"));
  }
  const qs = Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
  res.redirect(302, "/rook-onboarding-v4.html" + qs);
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  },
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ROOK server running on port ${PORT}`);
  // Pre-warm the active-jobs cache 5 s after boot so the first onboarding
  // preview request hits the cache instead of waiting 40+ s for a cold fetch.
  const { fetchActiveJobs } = require("./backend/scoring/precompute");
  const { createClient } = require("@supabase/supabase-js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    setTimeout(() => {
      const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      fetchActiveJobs(supabaseAdmin)
        .then(jobs => console.log(`[boot] active-jobs cache warmed: ${jobs.length} jobs`))
        .catch(err => console.warn(`[boot] cache warm failed: ${err.message}`));
    }, 5000);
  }
});
