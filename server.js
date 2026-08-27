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

// Server-rendered public pages (real per-job SEO meta tags + sitemap) —
// registered before the static file server and the SPA catch-all below,
// since /jobs/:id and /sitemap.xml aren't real files in /public.
app.use("/", require("./backend/routes/publicPages"));

// Static frontend (the UI prototype pages).
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ROOK server running on port ${PORT}`);
});
