// Stripe billing routes.
//
// Setup required before this works (see the PDF setup guide):
//   1. Create a Stripe account and a Product + Price for the $29/mo plan.
//   2. Put that Price ID in STRIPE_PRICE_ID_MONTHLY in your .env.
//   3. Put your Stripe secret key in STRIPE_SECRET_KEY.
//   4. Create a webhook endpoint in the Stripe dashboard pointing at
//      https://<your-app-domain>/api/stripe/webhook and put its signing
//      secret in STRIPE_WEBHOOK_SECRET. Make sure the endpoint is
//      subscribed to at least: checkout.session.completed,
//      customer.subscription.updated, customer.subscription.deleted,
//      and invoice.payment_failed.
//
// Free trial (2026-09): TRIAL_PERIOD_DAYS controls the trial length
// in days. Set it to 0 or remove it entirely to go back to charging
// $29 immediately at signup — no code change needed either way, this
// is the single switch.

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

// The trial-length switch. TRIAL_PERIOD_DAYS unset, empty, "0", or any
// non-positive value all mean "no trial" — checkout behaves exactly as
// it did before this feature existed (card charged immediately).
function getTrialPeriodDays() {
  const raw = Number(process.env.TRIAL_PERIOD_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

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

// GET /api/stripe/trial-config — public, no auth required (just a
// yes/no on whether a trial is currently offered, nothing sensitive).
// Direct instruction: disabling the trial via TRIAL_PERIOD_DAYS must be
// a true one-setting rollback with no copy change required anywhere —
// the pricing page calls this on load and switches its own CTA/
// messaging automatically, rather than having the trial-on/trial-off
// wording hardcoded on the frontend where flipping the env var alone
// wouldn't be enough to revert it. Deliberately not gated behind
// requireConfig — this is a plain env var read, unrelated to whether
// Stripe/Supabase credentials happen to be configured yet.
router.get("/stripe/trial-config", (req, res) => {
  res.json({ trialDays: getTrialPeriodDays() });
});

// Only these five keys are ever trusted from the client for attribution —
// an allowlist, not a blind passthrough of req.body, so this endpoint
// can't be used to write arbitrary metadata onto a Stripe object.
const UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
function pickUtmFields(body) {
  const out = {};
  for (const key of UTM_FIELDS) {
    if (body && typeof body[key] === "string" && body[key].trim()) out[key] = body[key].trim().slice(0, 200);
  }
  return out;
}

// POST /api/stripe/create-checkout-session
// Pure function, no Stripe/Express dependency — builds the exact
// checkout.sessions.create() params, so the trial-on vs trial-off
// (TRIAL_PERIOD_DAYS=0) branching can be verified directly in a test
// without a real HTTP request or a real Stripe account.
function buildCheckoutSessionParams({ trialDays, utm, userEmail, userId, publicAppUrl, priceId }) {
  const sessionParams = {
    mode: "subscription",
    payment_method_types: ["card"],
    // Explicit rather than relying on Stripe's default: a trial
    // subscription must still collect a real card up front, per
    // direct instruction. Stripe's default for subscription-mode
    // Checkout already does this, but this makes the requirement
    // impossible to silently lose to a future Stripe default change.
    payment_method_collection: "always",
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    // Direct instruction: this URL is the "Trial Started" signal, not
    // "Paid Subscription" — checkout completing here means a $0 trial
    // began, not that $29 was collected. Deliberately a different
    // query param than before (was checkout=success) so it can never
    // be confused with — or accidentally re-used for — the real
    // paid-conversion signal, which will fire from the webhook once
    // the first actual charge succeeds (separate follow-up; see
    // customer.subscription.updated below).
    //
    // Conditional on the trial actually being active: with
    // TRIAL_PERIOD_DAYS=0 (trial disabled), checkout completing here
    // IS an immediate real charge again, exactly like before this
    // feature existed — so this reverts to the original checkout=
    // success param in that case, keeping the existing LinkedIn
    // "Paid Subscription" conversion rule correctly matching the
    // scenario it was actually built for.
    success_url: trialDays > 0
      ? `${publicAppUrl}/rook-dashboard.html?trial=started`
      : `${publicAppUrl}/rook-dashboard.html?checkout=success`,
    cancel_url: `${publicAppUrl}/rook-pricing.html?checkout=cancelled`,
    client_reference_id: userId,
    // Also on the Checkout Session itself (not just subscription_data
    // below) so the attribution is visible on the Session object in
    // Stripe's dashboard even before a subscription exists.
    metadata: utm,
  };

  if (trialDays > 0) {
    sessionParams.subscription_data = { trial_period_days: trialDays, metadata: utm };
  } else if (Object.keys(utm).length > 0) {
    sessionParams.subscription_data = { metadata: utm };
  }

  return sessionParams;
}

// Called from the Pricing page's "Start Your N-Day Free Trial" button (N is dynamic, from TRIAL_PERIOD_DAYS)
// once the candidate is signed in. Redirects them to Stripe-hosted
// checkout.
router.post("/stripe/create-checkout-session", requireConfig, requireAuth, async (req, res) => {
  try {
    const trialDays = getTrialPeriodDays();
    const utm = pickUtmFields(req.body);
    const sessionParams = buildCheckoutSessionParams({
      trialDays,
      utm,
      userEmail: req.user.email,
      userId: req.user.id,
      publicAppUrl: process.env.PUBLIC_APP_URL,
      priceId: process.env.STRIPE_PRICE_ID_MONTHLY,
    });

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct instruction: "cancel anytime, keep access through the end of
// what you already paid/trial'd for" depends on the Stripe Dashboard's
// Customer Portal cancellation setting (Settings → Billing → Customer
// portal → Cancellations, mode "immediately" vs "at end of billing
// period") — a real account-level setting that lives entirely outside
// this codebase. ROOK's application code must NOT create or modify
// that configuration automatically; changing a live billing account's
// behavior as a side effect of a webhook/API route is exactly the kind
// of surprising, hard-to-trace mutation that should be a deliberate,
// reviewed action in Stripe's own dashboard, not something a code
// change silently does on your behalf.
//
// This is read-only: it checks the account's current Billing Portal
// configuration and logs a clear warning if the cancellation mode
// isn't what the product promises, but never creates or updates
// anything. Checked once per server process (cached — this is a
// once-per-deploy account setting, not something that changes request
// to request) so it costs at most one extra Stripe API call per
// process lifetime, not one per portal-session request.
let portalConfigCheckedThisProcess = false;
async function warnIfPortalCancellationModeIsWrong(stripeClient) {
  if (portalConfigCheckedThisProcess) return;
  portalConfigCheckedThisProcess = true;

  try {
    const configs = await stripeClient.billingPortal.configurations.list({ limit: 1, is_default: true });
    const config = configs.data[0];
    const mode = config?.features?.subscription_cancel?.mode;

    if (!config) {
      console.warn(
        "[stripe] No default Billing Portal configuration found on this account. " +
        "Customers won't be able to manage their subscription via the portal until one exists. " +
        "Set one up in the Stripe Dashboard: Settings -> Billing -> Customer portal."
      );
    } else if (mode !== "at_period_end") {
      console.warn(
        `[stripe] Billing Portal cancellation mode is currently "${mode || "unset"}", not "at_period_end". ` +
        "A trial or paying candidate who cancels via the portal will lose access IMMEDIATELY instead of " +
        "keeping it through their trial end / paid-through date, contradicting ROOK's own cancellation " +
        "promise. Fix in the Stripe Dashboard: Settings -> Billing -> Customer portal -> Cancellations -> " +
        "set 'When customers cancel their subscription' to 'At the end of the billing period'. " +
        "ROOK's code deliberately does not change this setting automatically."
      );
    }
  } catch (err) {
    // Never let this check itself break the actual portal-session
    // request it's running alongside — it's a diagnostic, not a
    // requirement for the feature to function.
    console.error(`[stripe] Could not check Billing Portal configuration: ${err.message}`);
  }
}

// Test-only: clears the in-memory "already checked" flag so a test can
// exercise the check more than once, instead of only ever hitting the
// already-checked fast path after the first call.
function _resetPortalConfigCheckForTests() {
  portalConfigCheckedThisProcess = false;
}

// POST /api/stripe/create-portal-session
// Called from Settings → Subscription's "Update Payment Method" button.
// Uses Stripe's own hosted billing portal — the candidate updates their
// card, views invoices, or cancels there directly, rather than ROOK
// needing to build any of that itself. Requires a stripe_customer_id on
// file, which is set once the candidate's first checkout completes (see
// the webhook handler below) — someone who's never subscribed has
// nothing to manage yet. Works identically for a trialing candidate —
// Stripe's portal already knows how to show/cancel a trial subscription,
// nothing ROOK-specific needed here for that.
router.post("/stripe/create-portal-session", requireConfig, requireAuth, async (req, res) => {
  // Whole handler wrapped in one try/catch now, not just the Stripe
  // call — a failure in the database lookup itself, or the response
  // never reaching res.json() for any other reason, was producing a
  // genuinely empty response body. The frontend's res.json() call then
  // threw its own confusing "Unexpected end of JSON input" instead of
  // ever showing the real problem. Every path out of this handler now
  // guarantees a real JSON body, even in a failure this code didn't
  // anticipate.
  try {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("candidate_profiles")
      .select("stripe_customer_id")
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: "No billing account on file yet — subscribe first from the Pricing page." });
    }

    // Read-only diagnostic — does not affect this request either way.
    warnIfPortalCancellationModeIsWrong(stripe);

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.PUBLIC_APP_URL || ""}/rook-settings.html?section=subscription`,
    });
    res.json({ url: session.url });
  } catch (err) {
    // Stripe throws a specific "resource_missing" error for a customer
    // ID that doesn't exist in the current mode — the exact situation
    // where an account's billing was set up in test mode before the
    // switch to live keys, and its stored customer ID no longer refers
    // to anything real. Detected specifically so the person sees an
    // actionable message instead of a generic one.
    if (err.code === "resource_missing" && err.param === "customer") {
      return res.status(409).json({
        error: "Your billing account needs to be reconnected. Please contact support to fix this — your subscription itself is fine, this is just a technical mismatch on the payment-management link.",
      });
    }
    console.error(`create-portal-session failed for user ${req.user?.id}: ${err.message}`);
    res.status(500).json({ error: "Could not open billing portal right now. Please try again shortly, or contact support if this keeps happening." });
  }
});

// Applies a subscription-status-affecting update with an out-of-order/
// duplicate-delivery guard. Stripe does not guarantee webhook delivery
// order, and will redeliver events on retry — without this guard, a
// delayed or redelivered OLDER event arriving after a newer one could
// silently regress an actively-paying subscriber's status back to
// something stale (e.g. back to "trialing", or undoing a cancellation
// that was itself later reversed). eventCreatedUnix is the Stripe
// event's own `created` timestamp (authoritative "when did this really
// happen," independent of network/retry timing), compared against the
// last-applied event's timestamp already on file for this row.
//
// matchColumn/matchValue identify the candidate_profiles row: by
// user_id for checkout.session.completed (client_reference_id is the
// only identifier available on that event), by stripe_customer_id for
// every other subscription/invoice event.
//
// Reported directly, a real production bug: the previous version did a
// separate SELECT to check staleness, then a separate UPDATE to write
// — two round trips with a gap between them. Two Stripe webhook events
// arriving close together (a live reactivate-then-cancel test, 19
// seconds apart) could interleave across that gap: the newer
// (cancellation) event's write landed first, then the older
// (reactivation) event's write — which had already read the row
// *before* the cancellation wrote — landed second and silently
// clobbered it, even though the guard's own timestamp logic was
// correct in isolation. A "newer event wins" check is worthless if a
// second request can still write in between the check and the write.
//
// Fixed by making the staleness check and the write the SAME
// Postgres statement: `UPDATE ... WHERE subscription_status_synced_at
// IS NULL OR subscription_status_synced_at < this_event's_timestamp`.
// Postgres evaluates that WHERE clause against the row's actual
// current value at the exact instant it takes the row lock for the
// write — not a snapshot read moments earlier in application code —
// so whichever event's write is processed SECOND by Postgres always
// sees whatever the first one already wrote, and correctly fails to
// match if it's the older event. There is no gap for a second request
// to land in. The timestamp comparison itself is a real Postgres
// timestamptz comparison (via .is()/.lt() against the actual column),
// not a JavaScript string comparison — the exact string format
// Postgres happens to return is irrelevant to it.
//
// Two sequential attempts, not one query with an OR, so this only
// relies on supabase-js's plain, well-documented single-condition
// filters rather than hand-built OR-filter strings: first assumes no
// prior sync exists at all (a brand new row), and only if that matches
// zero rows does it fall back to the "is this event newer than
// whatever's already there" comparison. Both attempts are
// independently atomic — there's no unsafe gap between them, since
// each one's WHERE clause is re-evaluated by Postgres against
// whatever the row's true value is at that exact moment, regardless of
// what the other attempt observed.
//
// setOnceFields (trial_started_at, subscription_started_at, the UTM
// columns) are handled as their own separate atomic conditional
// writes — `WHERE <gate column> IS NULL` — deliberately outside the
// staleness-guarded update above. They must never be touched by a
// stale/duplicate event, but they also must never be blocked by an
// unrelated, legitimate status change that doesn't concern them.
//
// Each entry is { gate, fields }: `gate` is the one column whose
// current NULL-ness decides whether this entire group gets written —
// e.g. the 5 UTM columns are one group gated on utm_source alone, so
// they're written together or not at all, rather than each column
// independently deciding based on its own (possibly legitimately
// empty) value.
async function applySetOnceFields(supabaseAdmin, matchColumn, matchValue, logPrefix, groups) {
  for (const { gate, fields } of groups) {
    const { error } = await supabaseAdmin
      .from("candidate_profiles")
      .update(fields)
      .eq(matchColumn, matchValue)
      .is(gate, null);
    if (error) {
      console.error(`${logPrefix}: failed to set-once (gated on "${gate}") — ${error.message}`);
    }
  }
}

async function applyGuardedSubscriptionUpdate(supabaseAdmin, { matchColumn, matchValue, eventId, eventCreatedUnix, fields, setOnceFields, reconcile }) {
  if (!matchValue) return { applied: false, reason: "no_match_value" };

  const eventCreatedAt = new Date(eventCreatedUnix * 1000).toISOString();
  const updatePayload = { ...fields, subscription_status_synced_at: eventCreatedAt };
  const logPrefix = `[stripe webhook] event ${eventId || "(no id)"} (created ${eventCreatedAt}) for ${matchColumn}=${matchValue}`;

  let { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .update(updatePayload)
    .eq(matchColumn, matchValue)
    .is("subscription_status_synced_at", null)
    .select("id");

  if (!error && (!data || data.length === 0)) {
    ({ data, error } = await supabaseAdmin
      .from("candidate_profiles")
      .update(updatePayload)
      .eq(matchColumn, matchValue)
      .lt("subscription_status_synced_at", eventCreatedAt)
      .select("id"));
  }

  if (error) {
    console.error(`${logPrefix}: DB ERROR — ${error.message}`);
    return { applied: false, reason: "update_error", error };
  }

  if (data && data.length > 0) {
    console.log(`${logPrefix}: APPLIED — fields: ${Object.keys(fields).join(", ") || "(none)"}`);
    if (setOnceFields && setOnceFields.length > 0) {
      await applySetOnceFields(supabaseAdmin, matchColumn, matchValue, logPrefix, setOnceFields);
    }
    return { applied: true, update: updatePayload };
  }

  // Neither attempt matched. Stripe's event.created has only
  // second-level precision, so this could mean either "a genuinely
  // later event already landed" (safe to skip) or "a DIFFERENT,
  // equally legitimate event landed in the same second" (NOT safe to
  // skip — that second event could represent newer information a
  // strict-inequality check has no way to order against this one).
  // This read exists ONLY to tell those two cases apart — it never
  // decides whether to apply THIS event's own payload, so it cannot
  // reintroduce the original read-then-write race the atomic update
  // above already closed.
  const { data: currentRow, error: readError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("subscription_status_synced_at")
    .eq(matchColumn, matchValue)
    .maybeSingle();

  if (readError) {
    console.error(`${logPrefix}: DB ERROR (tie-check read) — ${readError.message}`);
    return { applied: false, reason: "update_error", error: readError };
  }

  if (!currentRow) {
    console.log(`${logPrefix}: SKIPPED — no matching profile`);
    return { applied: false, reason: "no_matching_profile" };
  }

  const isExactTie = currentRow.subscription_status_synced_at === eventCreatedAt;

  if (!isExactTie || !reconcile) {
    console.log(`${logPrefix}: SKIPPED — a genuinely newer event is already recorded`);
    return { applied: false, reason: "stale_or_duplicate_event" };
  }

  // Direct instruction: do not use event ID ordering to break a tie —
  // Stripe event IDs are not chronologically sortable. Instead, ask
  // Stripe directly what's actually true right now for this
  // subscription, rather than trusting either tied webhook's payload
  // — this makes webhook delivery order irrelevant to the outcome,
  // which is the only real fix for a tie that database timestamps
  // alone cannot break.
  console.log(`${logPrefix}: TIE at ${eventCreatedAt} with an already-recorded event — reconciling directly against Stripe's live subscription state instead of trusting delivery order`);

  let authoritative;
  try {
    authoritative = await reconcile();
  } catch (err) {
    console.error(`${logPrefix}: reconciliation fetch failed — ${err.message}`);
    return { applied: false, reason: "reconcile_error", error: err };
  }

  const reconcilePayload = { ...authoritative.fields, subscription_status_synced_at: eventCreatedAt };
  const { error: reconcileError } = await supabaseAdmin
    .from("candidate_profiles")
    .update(reconcilePayload)
    .eq(matchColumn, matchValue);

  if (reconcileError) {
    console.error(`${logPrefix}: DB ERROR (reconciliation write) — ${reconcileError.message}`);
    return { applied: false, reason: "update_error", error: reconcileError };
  }

  console.log(`${logPrefix}: RECONCILED — fields: ${Object.keys(authoritative.fields).join(", ") || "(none)"}`);

  if (authoritative.setOnceFields && authoritative.setOnceFields.length > 0) {
    await applySetOnceFields(supabaseAdmin, matchColumn, matchValue, logPrefix, authoritative.setOnceFields);
  }

  return { applied: true, reconciled: true, update: reconcilePayload };
}

// Maps a LIVE Stripe subscription object (from stripe.subscriptions.
// retrieve(), not a webhook event payload) to our DB fields. Used both
// by checkout.session.completed (which already always fetches live)
// and by the tie-reconciliation path below, so there's one definition
// of "how do we turn Stripe's subscription state into our columns,"
// not two that could drift apart.
function mapLiveSubscriptionToFields(sub) {
  const fields = {
    subscription_status: sub.status,
    subscription_cancel_at: sub.cancel_at_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  };
  const setOnceFields = [];
  if (sub.status === "trialing" && sub.trial_end) {
    fields.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
  }
  if (sub.status === "active") {
    setOnceFields.push({ gate: "subscription_started_at", fields: { subscription_started_at: new Date().toISOString() } });
  }
  return { fields, setOnceFields };
}

// The actual event-handling logic, factored out of the route handler so
// it can be exercised directly in a test with a hand-built event object
// and a fake supabaseAdmin/stripe — no real HTTP request, no real Stripe
// signature, no real database required to verify this logic is correct.
async function handleStripeWebhookEvent(event, { stripe, supabaseAdmin }) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (!userId) return { applied: false, reason: "no_client_reference_id" };

      // The Checkout Session alone doesn't say whether a trial was
      // actually applied — retrieve the real subscription object so
      // the status written here is authoritative (Stripe's own
      // 'trialing' or 'active'), not assumed from what this server
      // requested at checkout-creation time. Keeps this correct even
      // if TRIAL_PERIOD_DAYS changes between when checkout was created
      // and when this webhook is processed.
      const sub = await stripe.subscriptions.retrieve(session.subscription);

      return applyGuardedSubscriptionUpdate(supabaseAdmin, {
        matchColumn: "user_id",
        matchValue: userId,
        eventId: event.id,
        eventCreatedUnix: event.created,
        fields: (() => {
          const fields = {
            subscription_status: sub.status,
            stripe_customer_id: session.customer,
          };
          if (sub.status === "trialing" && sub.trial_end) {
            fields.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
          }
          return fields;
        })(),
        setOnceFields: (() => {
          const groups = [];
          if (sub.status === "trialing") {
            groups.push({ gate: "trial_started_at", fields: { trial_started_at: new Date().toISOString() } });
          } else if (sub.status === "active") {
            // Trial disabled (TRIAL_PERIOD_DAYS=0) or somehow already
            // past trial by the time this webhook is processed — this
            // is the real "started paying" moment in that case.
            groups.push({ gate: "subscription_started_at", fields: { subscription_started_at: new Date().toISOString() } });
          }
          // UTM fallback: only fill in if onboarding didn't already
          // capture it (see routes/profile.js) — gated as one group on
          // utm_source alone, so all 5 columns are written together or
          // not at all, rather than each independently deciding based
          // on its own (possibly legitimately empty) value.
          const utm = pickUtmFields(session.metadata || {});
          if (Object.keys(utm).length > 0) {
            groups.push({ gate: "utm_source", fields: utm });
          }
          return groups;
        })(),
      });
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const cancelAt = sub.cancel_at_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

      return applyGuardedSubscriptionUpdate(supabaseAdmin, {
        matchColumn: "stripe_customer_id",
        matchValue: sub.customer,
        eventId: event.id,
        eventCreatedUnix: event.created,
        fields: {
          subscription_status: sub.status,
          // Reported via audit: ROOK showed "Professional Plan —
          // Active" with no indication a subscriber had already
          // cancelled via Stripe's own portal - Stripe doesn't
          // revoke access immediately on cancellation, it sets
          // cancel_at_period_end and keeps the subscription "active"
          // (or "trialing", if cancelled mid-trial) until the period
          // actually ends. subscription_cancel_at surfaces that
          // regardless of which status the cancellation happened
          // from.
          subscription_cancel_at: cancelAt,
        },
        // This is the real "first successful $29 payment" moment for
        // anyone who came through a trial — Stripe transitions the
        // subscription from 'trialing' to 'active' automatically when
        // the trial ends and the charge succeeds, which fires this
        // exact event. Set once, same pattern as everywhere else —
        // gated on subscription_started_at itself being null, so a
        // later renewal's "still active" event can't re-trigger it.
        setOnceFields: sub.status === "active"
          ? [{ gate: "subscription_started_at", fields: { subscription_started_at: new Date().toISOString() } }]
          : [],
        // Only invoked on an exact-timestamp tie with another event —
        // re-fetches this exact subscription live rather than trusting
        // this event's own (possibly out-of-date-by-the-time-it's-
        // processed) embedded object.
        reconcile: async () => mapLiveSubscriptionToFields(await stripe.subscriptions.retrieve(sub.id)),
      });
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      if (!invoice.subscription) return { applied: false, reason: "not_a_subscription_invoice" };

      return applyGuardedSubscriptionUpdate(supabaseAdmin, {
        matchColumn: "stripe_customer_id",
        matchValue: invoice.customer,
        eventId: event.id,
        eventCreatedUnix: event.created,
        fields: {
          // Direct instruction: a failed first (or any) charge must not
          // leave the account with paid access indefinitely. 'past_due'
          // is a real Stripe status and is neither 'trialing' nor
          // 'active', so hasFullAccess() immediately starts returning
          // false — the account is cut off from full access right away
          // rather than waiting on customer.subscription.updated to
          // arrive with the same information (it likely will too, close
          // behind this one; both converging on the same value is fine
          // and expected, not a conflict).
          subscription_status: "past_due",
        },
        reconcile: async () => mapLiveSubscriptionToFields(await stripe.subscriptions.retrieve(invoice.subscription)),
      });
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      return applyGuardedSubscriptionUpdate(supabaseAdmin, {
        matchColumn: "stripe_customer_id",
        matchValue: sub.customer,
        eventId: event.id,
        eventCreatedUnix: event.created,
        fields: {
          subscription_status: "cancelled",
          subscription_cancel_at: null,
        },
        reconcile: async () => mapLiveSubscriptionToFields(await stripe.subscriptions.retrieve(sub.id)),
      });
    }

    default:
      // Other event types are ignored for now.
      return { applied: false, reason: "unhandled_event_type" };
  }
}

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

  try {
    const result = await handleStripeWebhookEvent(event, { stripe, supabaseAdmin });
    if (!result.applied && result.reason && result.reason !== "unhandled_event_type") {
      console.log(`Webhook ${event.type} (${event.id}) not applied: ${result.reason}`);
    }
  } catch (err) {
    console.error(`Webhook ${event.type} (${event.id}) handling failed: ${err.message}`);
    // Still acknowledge receipt with 200 below rather than 500 — a
    // handler bug shouldn't make Stripe retry-storm an event forever.
    // The failure is logged for follow-up instead.
  }

  res.json({ received: true });
});

module.exports = router;
module.exports.handleStripeWebhookEvent = handleStripeWebhookEvent;
module.exports.applyGuardedSubscriptionUpdate = applyGuardedSubscriptionUpdate;
module.exports.getTrialPeriodDays = getTrialPeriodDays;
module.exports.buildCheckoutSessionParams = buildCheckoutSessionParams;
module.exports.warnIfPortalCancellationModeIsWrong = warnIfPortalCancellationModeIsWrong;
module.exports._resetPortalConfigCheckForTests = _resetPortalConfigCheckForTests;
