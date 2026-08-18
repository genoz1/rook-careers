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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
router.post("/stripe/create-checkout-session", requireAuth, async (req, res) => {
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

// POST /api/stripe/webhook
// Stripe calls this directly (not the browser) to notify you of
// subscription events. Must receive the RAW request body — see the
// express.raw() wiring for this route in server.js.
router.post("/stripe/webhook", async (req, res) => {
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
      await supabaseAdmin
        .from("candidate_profiles")
        .update({ subscription_status: "active", stripe_customer_id: session.customer })
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
