// Focused regression tests for the v6 signup boundary and onboarding route.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const signup = fs.readFileSync(path.join(root, "public/rook-onboarding-v6-signup.html"), "utf8");
const onboarding = fs.readFileSync(path.join(root, "public/rook-onboarding-v6.html"), "utf8");
const profile = fs.readFileSync(path.join(root, "backend/routes/profile.js"), "utf8");
const entry = fs.readFileSync(path.join(root, "public/rook-onboarding-v4.html"), "utf8");

function lastInlineScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return scripts.at(-1)[1];
}

function makeHarness(signUpResponse) {
  const nodes = new Map();
  const stored = new Map();
  const calls = { signup: [], verify: [], resend: [], prefill: [], signOut: 0 };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", innerHTML: "", disabled: false,
      style: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      focus() {},
      click() { return this.listeners.click?.(); }
    });
    return nodes.get(id);
  };
  const location = { href: "" };
  const auth = {
    async signUp(input) { calls.signup.push(input); return signUpResponse; },
    async signOut() { calls.signOut++; return { error: null }; },
    async verifyOtp(input) {
      calls.verify.push(input);
      return { data: { user: { id: "verified-id", email_confirmed_at: "2026-09-16T12:00:00Z" },
        session: { access_token: "verified-token" } }, error: null };
    },
    async resend(input) { calls.resend.push(input); return { error: null }; },
  };
  const ctx = {
    document: {
      getElementById: element,
      querySelector: selector => selector === ".screen h2" ? element("heading") : null,
    },
    window: {
      ROOK_CONFIG: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "public" },
      supabase: { createClient: () => ({ auth }) }, location,
    },
    sessionStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key),
    },
    fetch: async (url, options) => { calls.prefill.push({ url, options }); return { ok: true }; },
    setInterval: () => 1, clearInterval: () => {}, gtag: () => {},
  };
  vm.runInNewContext(lastInlineScript(signup), ctx);
  element("firstName").value = "Test";
  element("lastName").value = "Person";
  element("emailInput").value = "test@example.com";
  element("passwordInput").value = "password123";
  return { element, calls, location, stored };
}

async function run() {
  assert(!onboarding.includes('id="s-matches-preview"'));
  assert(!onboarding.includes("/api/onboarding/anonymous-preview"));
  assert(onboarding.includes("Create my free account"));
  assert(onboarding.includes("rook-onboarding-v6-signup.html"));
  assert(entry.includes("window.location.search"));
  assert(!profile.includes('router.post("/auth/confirm-email"'));
  assert(!signup.includes("/api/auth/confirm-email"));

  const h = makeHarness({ data: { user: { id: "pending-id" }, session: null }, error: null });
  await h.element("btnCreateAccount").click();
  assert.equal(h.location.href, "", "a pending email cannot reach the dashboard");
  assert.equal(h.calls.prefill.length, 0, "no profile save before verification");
  assert.equal(h.element("verifySection").style.display, "block");
  h.element("codeInput").value = "123";
  await h.element("btnVerifyCode").click();
  assert.equal(h.calls.verify.length, 0, "invalid code never submitted");
  h.element("codeInput").value = "123456";
  await h.element("btnVerifyCode").click();
  assert.equal(h.calls.verify.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.verify[0])), {
    email: "test@example.com", token: "123456", type: "email"
  });
  assert.equal(h.calls.prefill.length, 1);
  assert.equal(h.location.href, "rook-dashboard.html?welcome=1");
  assert.equal(h.stored.has("rook_v6_pending_email"), false);

  const immediate = makeHarness({
    data: { user: { id: "auto-confirmed" }, session: { access_token: "unverified" } }, error: null
  });
  await immediate.element("btnCreateAccount").click();
  assert.equal(immediate.calls.signOut, 1);
  assert.equal(immediate.location.href, "");
  assert.equal(immediate.calls.prefill.length, 0);
  console.log("V6 email code flow: passed");
}

run().catch(err => { console.error(err); process.exitCode = 1; });
