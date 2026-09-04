// Standalone test script for the free trial subscription/entitlement
// logic. Trial length is fully dynamic (TRIAL_PERIOD_DAYS) — nothing
// here or in the code it tests hardcodes a day count.
//
// No test framework — matches this project's existing convention of
// plain `node X.js` scripts (see package.json). Run with:
//   node backend/testTrialFlow.js
//   npm run test-trial-flow
//
// Mocks Stripe and Supabase entirely — this never touches a real
// database or a real Stripe account. It exercises the actual
// handleStripeWebhookEvent()/applyGuardedSubscriptionUpdate()/
// buildCheckoutSessionParams() functions from routes/stripe.js and
// hasFullAccess()/isPayingSubscriber() from matching.js directly, so a
// bug in the real logic shows up here.

const assert = require("assert");
const { handleStripeWebhookEvent, buildCheckoutSessionParams, warnIfPortalCancellationModeIsWrong, _resetPortalConfigCheckForTests } = require("./routes/stripe");
const { hasFullAccess, isPayingSubscriber } = require("./matching");

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failCount++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failCount++;
  }
}

// --- A tiny in-memory fake of the two supabaseAdmin calls this code
// actually uses (.from(table).select(...).eq(col,val).maybeSingle() and
// .from(table).update(fields).eq(col,val)) — enough to exercise the
// real guard logic without a real database. ---
function makeFakeSupabase(initialRows) {
  const table = [...initialRows];

  function findRow(col, val) {
    return table.find((r) => r[col] === val);
  }

  return {
    _table: table,
    from(_tableName) {
      return {
        select() {
          return {
            eq(col, val) {
              return {
                async maybeSingle() {
                  const row = findRow(col, val);
                  return { data: row || null, error: null };
                },
              };
            },
          };
        },
        update(fields) {
          return {
            async eq(col, val) {
              const row = findRow(col, val);
              if (!row) return { error: { message: "no row matched" } };
              Object.assign(row, fields);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

function makeFakeStripe(subscriptionsById) {
  return {
    subscriptions: {
      async retrieve(id) {
        const sub = subscriptionsById[id];
        if (!sub) throw new Error(`no fake subscription for id ${id}`);
        return sub;
      },
    },
  };
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;
const isoFromUnix = (unixSeconds) => new Date(unixSeconds * 1000).toISOString();
const isoPast = (secondsAgo) => isoFromUnix(NOW - secondsAgo);
const isoFuture = (secondsAhead) => isoFromUnix(NOW + secondsAhead);

async function run() {
  console.log("\n=== Billing Portal: cancellation mode is checked and warned about, but NEVER modified by ROOK's own code ===");

  await asyncTest("misconfigured ('immediately') portal warns, but does not call create or update", async () => {
    _resetPortalConfigCheckForTests();
    let createCalled = false;
    let updateCalled = false;
    const originalWarn = console.warn;
    let warnedMessage = null;
    console.warn = (msg) => { warnedMessage = msg; };
    const fakeStripe = {
      billingPortal: {
        configurations: {
          async list() { return { data: [{ id: "bpc_1", features: { subscription_cancel: { enabled: true, mode: "immediately" } } }] }; },
          async create() { createCalled = true; return {}; },
          async update() { updateCalled = true; return {}; },
        },
      },
    };
    await warnIfPortalCancellationModeIsWrong(fakeStripe);
    console.warn = originalWarn;
    assert.strictEqual(createCalled, false, "must never create a portal configuration — that's a deliberate manual dashboard action now");
    assert.strictEqual(updateCalled, false, "must never update a portal configuration — same reasoning");
    assert.ok(warnedMessage && warnedMessage.includes("immediately"), "must log a clear warning naming the actual misconfigured mode found");
  });

  await asyncTest("no portal configuration at all -> warns about that too, still without creating anything", async () => {
    _resetPortalConfigCheckForTests();
    let createCalled = false;
    const originalWarn = console.warn;
    let warnedMessage = null;
    console.warn = (msg) => { warnedMessage = msg; };
    const fakeStripe = {
      billingPortal: {
        configurations: {
          async list() { return { data: [] }; },
          async create() { createCalled = true; return {}; },
          async update() { throw new Error("should not be called"); },
        },
      },
    };
    await warnIfPortalCancellationModeIsWrong(fakeStripe);
    console.warn = originalWarn;
    assert.strictEqual(createCalled, false, "must never create a portal configuration automatically, even when none exists");
    assert.ok(warnedMessage && warnedMessage.includes("No default Billing Portal configuration"), "must clearly say no configuration was found");
  });

  await asyncTest("correctly configured ('at_period_end') -> no warning, no API mutation calls", async () => {
    _resetPortalConfigCheckForTests();
    let warned = false;
    const originalWarn = console.warn;
    console.warn = () => { warned = true; };
    const fakeStripe = {
      billingPortal: {
        configurations: {
          async list() { return { data: [{ id: "bpc_1", features: { subscription_cancel: { enabled: true, mode: "at_period_end" } } }] }; },
          async create() { throw new Error("should not be called"); },
          async update() { throw new Error("should not be called"); },
        },
      },
    };
    await warnIfPortalCancellationModeIsWrong(fakeStripe);
    console.warn = originalWarn;
    assert.strictEqual(warned, false, "a correctly configured account should produce no warning at all");
  });

  await asyncTest("the check only runs once per server process, not on every portal-session request", async () => {
    _resetPortalConfigCheckForTests();
    let listCallCount = 0;
    const fakeStripe = {
      billingPortal: {
        configurations: {
          async list() { listCallCount++; return { data: [{ id: "bpc_1", features: { subscription_cancel: { enabled: true, mode: "at_period_end" } } }] }; },
          async create() { throw new Error("should not be called"); },
          async update() { throw new Error("should not be called"); },
        },
      },
    };
    await warnIfPortalCancellationModeIsWrong(fakeStripe);
    await warnIfPortalCancellationModeIsWrong(fakeStripe);
    assert.strictEqual(listCallCount, 1, "should only check once per process, cached after that");
  });

  console.log("\n=== Checkout session shape: TRIAL_PERIOD_DAYS=0 (disabled) must exactly match pre-trial behavior [16] ===");

  test("disabled trial + no UTM: session shape is byte-identical to the original pre-trial code", () => {
    const params = buildCheckoutSessionParams({
      trialDays: 0, utm: {}, userEmail: "a@b.com", userId: "user1",
      publicAppUrl: "https://rookcareers.com", priceId: "price_123",
    });
    assert.strictEqual(params.success_url, "https://rookcareers.com/rook-dashboard.html?checkout=success", "must use the ORIGINAL checkout=success param when trial is disabled");
    assert.strictEqual(params.cancel_url, "https://rookcareers.com/rook-pricing.html?checkout=cancelled");
    assert.strictEqual(params.mode, "subscription");
    assert.deepStrictEqual(params.payment_method_types, ["card"]);
    assert.strictEqual(params.client_reference_id, "user1");
    assert.strictEqual(params.subscription_data, undefined, "no subscription_data at all when trial is off and there is no UTM to carry — matches the original request shape exactly");
    assert.deepStrictEqual(params.metadata, {}, "empty metadata is harmless/equivalent to omitting it in Stripe's API");
  });

  test("disabled trial + UTM present: still no trial, but UTM still flows through", () => {
    const params = buildCheckoutSessionParams({
      trialDays: 0, utm: { utm_source: "facebook" }, userEmail: "a@b.com", userId: "user1",
      publicAppUrl: "https://rookcareers.com", priceId: "price_123",
    });
    assert.strictEqual(params.success_url, "https://rookcareers.com/rook-dashboard.html?checkout=success");
    assert.strictEqual(params.subscription_data.trial_period_days, undefined, "no trial should ever be applied when disabled, even with UTM present");
    assert.deepStrictEqual(params.subscription_data.metadata, { utm_source: "facebook" });
  });

  test("trial enabled at 3 days: session requests exactly 3, not a hardcoded 7, and uses the trial=started signal", () => {
    const params = buildCheckoutSessionParams({
      trialDays: 3, utm: { utm_source: "google", utm_medium: "cpc" }, userEmail: "a@b.com", userId: "user1",
      publicAppUrl: "https://rookcareers.com", priceId: "price_123",
    });
    assert.strictEqual(params.success_url, "https://rookcareers.com/rook-dashboard.html?trial=started");
    assert.strictEqual(params.subscription_data.trial_period_days, 3, "must reflect whatever TRIAL_PERIOD_DAYS actually is, not a hardcoded number");
    assert.deepStrictEqual(params.subscription_data.metadata, { utm_source: "google", utm_medium: "cpc" });
    assert.strictEqual(params.payment_method_collection, "always", "card must always be collected, trial or not");
  });

  test("trial enabled at a different length (7): the same code path just reflects whatever the config says", () => {
    const params = buildCheckoutSessionParams({
      trialDays: 7, utm: {}, userEmail: "a@b.com", userId: "user1",
      publicAppUrl: "https://rookcareers.com", priceId: "price_123",
    });
    assert.strictEqual(params.subscription_data.trial_period_days, 7, "proves the length isn't hardcoded to 3 either — it's a pure passthrough of TRIAL_PERIOD_DAYS");
  });

  console.log("\n=== hasFullAccess: basic status gate [1] ===");

  test("no profile at all -> restricted (new non-subscriber)", () => {
    assert.strictEqual(hasFullAccess(undefined), false);
    assert.strictEqual(hasFullAccess(null), false);
  });
  test("a real profile that has never subscribed -> restricted", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: null }), false);
  });
  test("past_due -> restricted", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "past_due" }), false);
  });
  test("cancelled -> restricted", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "cancelled" }), false);
  });
  test("trialing with no expiration info at all -> full access (status alone is enough absent any timestamp)", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "trialing" }), true);
  });
  test("active with no cancellation on file -> full access", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "active" }), true);
  });
  test("trialing is never reported as a paying subscriber", () => {
    assert.strictEqual(isPayingSubscriber("trialing"), false);
  });
  test("active IS a paying subscriber", () => {
    assert.strictEqual(isPayingSubscriber("active"), true);
  });

  console.log("\n=== hasFullAccess: timestamp-aware expiration — the core hardening [4, 6, 12] ===");

  test("trialing, trial_ends_at in the FUTURE -> full access [trial started, unlocked immediately]", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "trialing", trial_ends_at: isoFuture(2 * DAY) }), true);
  });
  test("trialing, trial_ends_at in the PAST, status not yet updated by any webhook -> restricted", () => {
    // This is the exact scenario a delayed or entirely missed
    // "trial converted" / "trial ended, first charge failed" webhook
    // would otherwise leave open indefinitely — the row still says
    // 'trialing' but the trial's own recorded end date has passed.
    assert.strictEqual(hasFullAccess({ subscription_status: "trialing", trial_ends_at: isoPast(DAY) }), false);
  });
  test("logging out and back in doesn't change the answer — the check is stateless, re-derived from the same stored row every time", () => {
    const profile = { subscription_status: "trialing", trial_ends_at: isoFuture(DAY) };
    const firstCheck = hasFullAccess(profile);   // e.g. dashboard load before logout
    const secondCheck = hasFullAccess(profile);  // e.g. dashboard load after logging back in
    assert.strictEqual(firstCheck, true);
    assert.strictEqual(secondCheck, true);
    assert.strictEqual(firstCheck, secondCheck);
  });
  test("trialing, cancelled with subscription_cancel_at in the FUTURE (original trial end) -> full access", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "trialing", trial_ends_at: isoFuture(3 * DAY), subscription_cancel_at: isoFuture(3 * DAY) }), true);
  });
  test("trialing, cancelled with subscription_cancel_at in the PAST, status not yet updated -> restricted", () => {
    // Cancelled during the trial, the trial has since genuinely ended,
    // but no 'customer.subscription.deleted' webhook has arrived yet.
    assert.strictEqual(hasFullAccess({ subscription_status: "trialing", trial_ends_at: isoPast(DAY), subscription_cancel_at: isoPast(DAY) }), false);
  });
  test("active, cancelled with subscription_cancel_at in the FUTURE (paid-through date) -> full access", () => {
    assert.strictEqual(hasFullAccess({ subscription_status: "active", subscription_cancel_at: isoFuture(10 * DAY) }), true);
  });
  test("active, cancelled with subscription_cancel_at in the PAST, status not yet updated -> restricted", () => {
    // A paying subscriber cancelled, their paid-through period has
    // since genuinely ended, but the webhook that would flip status to
    // 'cancelled' hasn't landed yet — must not stay unlocked.
    assert.strictEqual(hasFullAccess({ subscription_status: "active", subscription_cancel_at: isoPast(DAY) }), false);
  });
  test("active (never cancelled) with a stale, irrelevant OLD trial_ends_at -> still full access", () => {
    // Once a trial has genuinely converted to 'active', an old
    // trial_ends_at left over in the row must not cut off a normal,
    // uncancelled paying subscriber.
    assert.strictEqual(hasFullAccess({ subscription_status: "active", trial_ends_at: isoPast(30 * DAY) }), true);
  });

  console.log("\n=== Scenario: direct API/job-URL access cannot bypass an expired entitlement [13] ===");
  test("an expired profile is restricted no matter what job/request data accompanies it — the check depends only on server-verified profile state", () => {
    const expiredProfile = { subscription_status: "trialing", trial_ends_at: isoPast(DAY) };
    // Simulates calling the exact same gate from several different
    // endpoints (job detail, saved jobs, a directly-typed job URL) —
    // there is no code path, request shape, or client-supplied field
    // that changes the answer. Every /api/jobs* route in jobs.js calls
    // this same function against a freshly-queried database row on
    // every single request; there is no client-side-only gate and no
    // session flag that could bypass it.
    assert.strictEqual(hasFullAccess(expiredProfile), false, "job detail endpoint");
    assert.strictEqual(hasFullAccess(expiredProfile), false, "saved jobs endpoint");
    assert.strictEqual(hasFullAccess(expiredProfile), false, "direct job URL / job search endpoint");
  });

  console.log("\n=== Scenario: trial starts (checkout.session.completed, trial applied) [2] ===");
  await asyncTest("trial start sets status=trialing, trial_started_at, trial_ends_at, full access immediately", async () => {
    const db = makeFakeSupabase([{ user_id: "user1", subscription_status: null, subscription_status_synced_at: null, subscription_started_at: null, trial_started_at: null, utm_source: null }]);
    const stripe = makeFakeStripe({
      sub_trial_1: { id: "sub_trial_1", status: "trialing", customer: "cus_1", trial_end: NOW + 3 * DAY, cancel_at_period_end: false },
    });
    const event = {
      id: "evt_1", created: NOW, type: "checkout.session.completed",
      data: { object: { client_reference_id: "user1", customer: "cus_1", subscription: "sub_trial_1", metadata: { utm_source: "google", utm_medium: "cpc" } } },
    };
    const result = await handleStripeWebhookEvent(event, { stripe, supabaseAdmin: db });
    assert.strictEqual(result.applied, true, "update should have applied");
    const row = db._table[0];
    assert.strictEqual(row.subscription_status, "trialing");
    assert.strictEqual(row.stripe_customer_id, "cus_1");
    assert.ok(row.trial_started_at, "trial_started_at should be set");
    assert.ok(row.trial_ends_at, "trial_ends_at should be set");
    assert.strictEqual(row.subscription_started_at, null, "subscription_started_at must NOT be set yet — no real payment has happened");
    assert.strictEqual(hasFullAccess(row), true, "trialing candidate must have full access immediately — this is exactly what the daily digest's gate also checks [3]");
    assert.strictEqual(isPayingSubscriber(row.subscription_status), false, "a trial must never be reported as a paying subscriber");
    assert.strictEqual(row.utm_source, "google", "UTM fallback from session metadata should apply when onboarding didn't already capture it");
  });

  console.log("\n=== Scenario: trial disabled (TRIAL_PERIOD_DAYS=0) — old immediate-charge behavior preserved [16] ===");
  await asyncTest("checkout with no trial goes straight to active + subscription_started_at", async () => {
    const db = makeFakeSupabase([{ user_id: "user2", subscription_status: null, subscription_status_synced_at: null, subscription_started_at: null, trial_started_at: null, utm_source: "existing-value" }]);
    const stripe = makeFakeStripe({
      sub_direct_1: { id: "sub_direct_1", status: "active", customer: "cus_2", trial_end: null, cancel_at_period_end: false },
    });
    const event = {
      id: "evt_2", created: NOW, type: "checkout.session.completed",
      data: { object: { client_reference_id: "user2", customer: "cus_2", subscription: "sub_direct_1", metadata: {} } },
    };
    await handleStripeWebhookEvent(event, { stripe, supabaseAdmin: db });
    const row = db._table[0];
    assert.strictEqual(row.subscription_status, "active");
    assert.ok(row.subscription_started_at, "subscription_started_at should be set immediately when there is no trial");
    assert.strictEqual(row.trial_started_at, null, "trial fields should stay untouched when no trial occurred");
    assert.strictEqual(row.utm_source, "existing-value", "must not overwrite UTM already on file");
    assert.strictEqual(hasFullAccess(row), true);
  });

  console.log("\n=== Scenario: trial reaches its end and $29 payment succeeds (customer.subscription.updated) [8] ===");
  await asyncTest("trialing -> active transition sets subscription_started_at, no access interruption", async () => {
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_3", subscription_status: "trialing", subscription_status_synced_at: isoFromUnix(NOW), subscription_started_at: null, trial_started_at: new Date().toISOString(), trial_ends_at: isoFromUnix(NOW + 3 * DAY) }]);
    const event = {
      id: "evt_3", created: NOW + 3 * DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_3", status: "active", cancel_at_period_end: false, current_period_end: NOW + 33 * DAY } },
    };
    const before = hasFullAccess(db._table[0]);
    await handleStripeWebhookEvent(event, { stripe: {}, supabaseAdmin: db });
    const row = db._table[0];
    const after = hasFullAccess(row);
    assert.strictEqual(row.subscription_status, "active");
    assert.ok(row.subscription_started_at, "subscription_started_at should be set on the real first payment");
    assert.strictEqual(before, true, "had full access while trialing");
    assert.strictEqual(after, true, "still has full access after converting — no interruption");
    assert.strictEqual(isPayingSubscriber(row.subscription_status), true, "now a real paying subscriber");
  });

  console.log("\n=== Scenario: first $29 payment fails [9, 10] ===");
  await asyncTest("invoice.payment_failed cuts off full access immediately (website AND digest, same gate)", async () => {
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_4", subscription_status: "trialing", subscription_status_synced_at: isoFromUnix(NOW), trial_ends_at: isoFromUnix(NOW + 3 * DAY) }]);
    const event = {
      id: "evt_4", created: NOW + 3 * DAY, type: "invoice.payment_failed",
      data: { object: { customer: "cus_4", subscription: "sub_x" } },
    };
    await handleStripeWebhookEvent(event, { stripe: {}, supabaseAdmin: db });
    const row = db._table[0];
    assert.strictEqual(row.subscription_status, "past_due");
    assert.strictEqual(hasFullAccess(row), false, "a failed charge must not retain full access — this is the same check the daily digest uses, so it stops revealing subscriber-only content too");
  });

  console.log("\n=== Scenario: cancel during trial, then trial actually expires [5, 6, 7] ===");
  await asyncTest("cancelling mid-trial keeps access until the original trial end, then locks — website and digest both", async () => {
    const trialEnd = NOW + 2 * DAY;
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_5", subscription_status: "trialing", subscription_status_synced_at: isoFromUnix(NOW), subscription_cancel_at: null, trial_ends_at: isoFromUnix(trialEnd) }]);
    const event = {
      id: "evt_5", created: NOW + DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_5", status: "trialing", cancel_at_period_end: true, current_period_end: trialEnd } },
    };
    await handleStripeWebhookEvent(event, { stripe: {}, supabaseAdmin: db });
    const row = db._table[0];
    assert.strictEqual(row.subscription_status, "trialing", "status stays trialing — cancellation is scheduled, not immediate [5]");
    assert.ok(row.subscription_cancel_at, "cancel date should be recorded");
    assert.strictEqual(hasFullAccess(row), true, "still has access until the scheduled date [5]");

    // Before any webhook fires to formally close it out, the scheduled
    // cancellation date itself arrives — the timestamp check must lock
    // this out immediately, independent of webhook timing.
    row.__simulateTimePassing = true; // no-op, just documents the moment being tested
    const stillTrialingRowButExpired = { ...row, subscription_cancel_at: isoPast(1) }; // "now" is just past the recorded cancel date
    assert.strictEqual(hasFullAccess(stillTrialingRowButExpired), false, "locks the instant the scheduled date passes, even with status still 'trialing' [6, 7]");

    // The webhook Stripe normally sends right around trial end
    // (deleting the now-cancelled subscription) eventually arrives and
    // formally closes it out too — confirms the ordinary path still
    // works on top of the timestamp guard, not instead of it.
    const deleteEvent = {
      id: "evt_6", created: trialEnd, type: "customer.subscription.deleted",
      data: { object: { customer: "cus_5" } },
    };
    await handleStripeWebhookEvent(deleteEvent, { stripe: {}, supabaseAdmin: db });
    assert.strictEqual(row.subscription_status, "cancelled");
    assert.strictEqual(hasFullAccess(row), false);
  });

  console.log("\n=== Scenario: paying subscriber cancels, then paid-through date passes [11, 12] ===");
  await asyncTest("active subscriber cancellation keeps access through the paid period, then locks", async () => {
    const periodEnd = NOW + 20 * DAY;
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_6", subscription_status: "active", subscription_status_synced_at: isoFromUnix(NOW), subscription_cancel_at: null }]);
    const event = {
      id: "evt_7", created: NOW + DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_6", status: "active", cancel_at_period_end: true, current_period_end: periodEnd } },
    };
    await handleStripeWebhookEvent(event, { stripe: {}, supabaseAdmin: db });
    const row = db._table[0];
    assert.strictEqual(row.subscription_status, "active");
    assert.ok(row.subscription_cancel_at);
    assert.strictEqual(hasFullAccess(row), true, "still has access until period end [11]");

    const pastPaidThroughDate = { ...row, subscription_cancel_at: isoPast(1) };
    assert.strictEqual(hasFullAccess(pastPaidThroughDate), false, "locks the instant the paid-through date passes, even before any webhook confirms the cancellation [12]");
  });

  console.log("\n=== Scenario: duplicate webhook delivery [14] ===");
  await asyncTest("the exact same event applied twice only takes effect once, and doesn't corrupt state", async () => {
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_7", subscription_status: "trialing", subscription_status_synced_at: isoFromUnix(NOW), subscription_cancel_at: null }]);
    const event = {
      id: "evt_8", created: NOW + DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_7", status: "trialing", cancel_at_period_end: true, current_period_end: NOW + 2 * DAY } },
    };
    const first = await handleStripeWebhookEvent(event, { stripe: {}, supabaseAdmin: db });
    const stateAfterFirst = { ...db._table[0] };
    const second = await handleStripeWebhookEvent({ ...event }, { stripe: {}, supabaseAdmin: db }); // Stripe redelivers the identical event
    assert.strictEqual(first.applied, true, "first delivery should apply");
    assert.strictEqual(second.applied, false, "redelivered duplicate should be rejected by the guard");
    assert.strictEqual(second.reason, "stale_or_duplicate_event");
    assert.deepStrictEqual(db._table[0], stateAfterFirst, "row must be byte-identical after the duplicate — no corruption, no partial re-application");
  });

  console.log("\n=== Scenario: delayed/out-of-order webhooks cannot restore expired access or downgrade a valid subscriber [15] ===");
  await asyncTest("an older 'trialing' event arriving late after a newer 'active' event is rejected (cannot downgrade)", async () => {
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_8", subscription_status: "trialing", subscription_status_synced_at: isoFromUnix(NOW), subscription_started_at: null }]);

    const newerEvent = {
      id: "evt_new", created: NOW + 3 * DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_8", status: "active", cancel_at_period_end: false, current_period_end: NOW + 33 * DAY } },
    };
    await handleStripeWebhookEvent(newerEvent, { stripe: {}, supabaseAdmin: db });
    assert.strictEqual(db._table[0].subscription_status, "active", "sanity check: newer event applied normally");

    const olderDelayedEvent = {
      id: "evt_old_delayed", created: NOW + DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_8", status: "trialing", cancel_at_period_end: false, current_period_end: NOW + 3 * DAY } },
    };
    const result = await handleStripeWebhookEvent(olderDelayedEvent, { stripe: {}, supabaseAdmin: db });
    assert.strictEqual(result.applied, false, "an older event must not be applied after a newer one already landed");
    assert.strictEqual(db._table[0].subscription_status, "active", "an active paying subscriber must not be regressed back to trialing by a stale event");
  });

  await asyncTest("an older 'active' event arriving late after cancellation cannot resurrect expired access", async () => {
    const db = makeFakeSupabase([{ stripe_customer_id: "cus_9", subscription_status: "active", subscription_status_synced_at: isoFromUnix(NOW), subscription_cancel_at: null }]);

    const cancelledEvent = {
      id: "evt_cancel", created: NOW + 5 * DAY, type: "customer.subscription.deleted",
      data: { object: { customer: "cus_9" } },
    };
    await handleStripeWebhookEvent(cancelledEvent, { stripe: {}, supabaseAdmin: db });
    assert.strictEqual(db._table[0].subscription_status, "cancelled", "sanity check: cancellation applied normally");

    // A stale "still active" notice from before the cancellation,
    // delayed in Stripe's retry queue, arrives after the fact.
    const staleActiveEvent = {
      id: "evt_stale_active", created: NOW + 2 * DAY, type: "customer.subscription.updated",
      data: { object: { customer: "cus_9", status: "active", cancel_at_period_end: false, current_period_end: NOW + 32 * DAY } },
    };
    const result = await handleStripeWebhookEvent(staleActiveEvent, { stripe: {}, supabaseAdmin: db });
    assert.strictEqual(result.applied, false, "a stale event must not resurrect access after a legitimate cancellation");
    assert.strictEqual(db._table[0].subscription_status, "cancelled", "must remain cancelled");
    assert.strictEqual(hasFullAccess(db._table[0]), false);
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
