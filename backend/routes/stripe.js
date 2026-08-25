// Stripe billing routes.
//
// Setup required before this works (see the PDF setup guide):
//   1. Create a Stripe account and a Product + Price for the $29/mo plan.
//   2. Put that Price ID in STRIPE_PRICE_ID_MONTHLY in your .env.
//   3. Put your Stripe secret key in STRIPE_SECRET_KEY.
//   4. Create a webhook endpoint in the Stripe dashboard pointing at
//      https://<your-app-domain>/api/stripe/webhook and put its signing
//      secret in STRIPE_WEBHOOK_SECRET.

const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

// Build these clients defensively: missing credentials should mean "the
// Stripe/billing routes return a clear error when called," NOT "the whole
// server crashes on startup." Both the Stripe SDK and supabase-js throw
// synchronously if given undefined/empty config, so we guard against that.
const isConfigured = Boolean(
  process.env.STRIPE_SECRET_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const supabaseAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured || !stripe || !supabaseAnon || !supabaseAdmin) {
    return res.status(503).json({
      error: "Stripe/Supabase aren't configured on this server yet. See ROOK-Setup-Guide.pdf.",
    });
  }
  next();
}

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = data.user;
  next();
}

// POST /api/stripe/create-checkout-session
// Called from the Pricing page's "Get My Matches" button once the
// candidate is signed in. Redirects them to Stripe-hosted checkout.
router.post("/stripe/create-checkout-session", requireConfig, requireAuth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID_MONTHLY, quantity: 1 }],
      success_url: `${process.env.PUBLIC_APP_URL}/rook-dashboard.html?checkout=success`,
      cancel_url: `${process.env.PUBLIC_APP_URL}/rook-pricing.html?checkout=cancelled`,
      client_reference_id: req.user.id,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/create-portal-session
// Called from Settings → Subscription's "Update Payment Method" button.
// Uses Stripe's own hosted billing portal — the candidate updates their
// card, views invoices, or cancels there directly, rather than ROOK
// needing to build any of that itself. Requires a stripe_customer_id on
// file, which is set once the candidate's first checkout completes (see
// the webhook handler below) — someone who's never subscribed has
// nothing to manage yet.
router.post("/stripe/create-portal-session", requireConfig, requireAuth, async (req, res) => {
  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("stripe_customer_id")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: "No billing account on file yet — subscribe first from the Pricing page." });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.PUBLIC_APP_URL}/rook-settings.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/webhook
// Stripe calls this directly (not the browser) to notify you of
// subscription events. Must receive the RAW request body — see the
// express.raw() wiring for this route in server.js.
router.post("/stripe/webhook", requireConfig, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.client_reference_id;
      // Mark the candidate as subscribed. Add a `subscription_status`
      // and `stripe_customer_id` column to candidate_profiles if you
      // want to track this in the same table.
      // subscription_started_at is only ever set here, the first time a
      // given candidate goes active — NOT overwritten on later renewal
      // events, since it anchors the 30-day/5-Excellent-Match guarantee
      // window to when they first paid, not to unrelated later webhook
      // activity. checkout.session.completed only fires on that initial
      // purchase, so a plain update on every hit here is already safe,
      // but the guard below makes that explicit instead of relying on
      // Stripe's event semantics alone.
      const { data: existing } = await supabaseAdmin
        .from("candidate_profiles")
        .select("subscription_started_at")
        .eq("user_id", userId)
        .maybeSingle();
      const update = { subscription_status: "active", stripe_customer_id: session.customer };
      if (!existing?.subscription_started_at) update.subscription_started_at = new Date().toISOString();
      await supabaseAdmin
        .from("candidate_profiles")
        .update(update)
        .eq("user_id", userId);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await supabaseAdmin
        .from("candidate_profiles")
        .update({ subscription_status: "cancelled" })
        .eq("stripe_customer_id", sub.customer);
      break;
    }
    default:
      // Other event types are ignored for now.
      break;
  }

  res.json({ received: true });
});

module.exports = router;
