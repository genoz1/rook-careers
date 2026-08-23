require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

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
