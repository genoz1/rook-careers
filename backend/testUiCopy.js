// Regression tests for the conversion/UI audit fixes (2026-09).
// Run with: node backend/testUiCopy.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { scoreJob } = require("./matching");

let passCount = 0, failCount = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passCount++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failCount++; }
}

function readPublic(file) {
  return fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
}

function baseProfile(overrides = {}) {
  return {
    home_lat: 28.5, home_lng: -81.4, home_state: "FL",
    resume_structured: { sales_motion: [], required_industries: [], product_categories: [] },
    onboarding: {},
    ...overrides,
  };
}
function baseJob(overrides = {}) {
  return {
    id: "job-1", job_lat: 28.5, job_lng: -81.4, state: "FL",
    ai_analysis: { sales_motion: [], required_industries: [], product_categories: [] },
    ...overrides,
  };
}

console.log("\n=== REGRESSION: confirmed 'sales sales' duplication bug ===");
test("a sales_motion value that already ends in 'Sales' (e.g. 'Direct Sales') never duplicates the word", () => {
  const profile = baseProfile({ resume_structured: { sales_motion: ["Direct Sales"] } });
  const job = baseJob({ ai_analysis: { sales_motion: ["Direct Sales"] } });
  const result = scoreJob(job, profile);
  const motionReason = (result.reasons || []).find((r) => r.includes("Direct Sales"));
  assert.ok(motionReason, "sanity check — the sales-motion reason must actually be generated");
  assert.ok(!/sales sales/i.test(motionReason), `must never contain duplicated "sales sales": "${motionReason}"`);
  assert.strictEqual(motionReason, "Your Direct Sales experience matches this role's style");
});
test("every other documented sales_motion value ending in 'Sales' is also covered (Inside, Outside, Enterprise, Consultative, Channel/Distributor)", () => {
  for (const motion of ["Inside Sales", "Outside Sales", "Enterprise Sales", "Consultative Sales", "Channel/Distributor Sales"]) {
    const profile = baseProfile({ resume_structured: { sales_motion: [motion] } });
    const job = baseJob({ ai_analysis: { sales_motion: [motion] } });
    const result = scoreJob(job, profile);
    const motionReason = (result.reasons || []).find((r) => r.includes(motion));
    assert.ok(!/sales sales/i.test(motionReason || ""), `"${motion}" must not produce duplicated "sales sales"`);
  }
});
test("a sales_motion value that does NOT already end in 'Sales' (e.g. 'Hunter') still gets the word appended normally", () => {
  const profile = baseProfile({ resume_structured: { sales_motion: ["Hunter"] } });
  const job = baseJob({ ai_analysis: { sales_motion: ["Hunter"] } });
  const result = scoreJob(job, profile);
  const motionReason = (result.reasons || []).find((r) => r.includes("Hunter"));
  assert.strictEqual(motionReason, "Your Hunter sales experience matches this role's style");
});

console.log("\n=== REGRESSION: 'Strong Apply' renamed to 'Strong Match' (score thresholds unchanged) ===");
test("a 90+ overall score now produces the label 'Strong Match', not 'Strong Apply'", () => {
  const profile = baseProfile({
    resume_structured: {
      sales_motion: ["Territory Development"], required_industries: ["Medical Device"], product_categories: ["Surgical"],
      years_of_experience: 8, seniority_level: "Senior",
    },
    home_zip: "32162",
  });
  const job = baseJob({
    ai_analysis: {
      sales_motion: ["Territory Development"], required_industries: ["Medical Device"], product_categories: ["Surgical"],
      seniority_level: "Senior", required_years_experience: 5,
    },
    compensation_text: "$100,000 - $130,000", salary_min: 100000, salary_max: 130000,
  });
  const result = scoreJob(job, profile);
  if (result.overall_score >= 90) {
    assert.strictEqual(result.recommendation, "Strong Match");
  }
  assert.ok(!["Strong Apply"].includes(result.recommendation), "the old label string must never be produced");
});
test("the 90-point threshold itself is completely unchanged — only the label string changed", () => {
  const src = fs.readFileSync(path.join(__dirname, "matching.js"), "utf8");
  assert.ok(src.includes('if (score >= 90) return "Strong Match";'), "threshold and label must match exactly this line");
});

console.log("\n=== REGRESSION: 'Sourced via workday'-style raw technical labels replaced ===");
test("rook-job-analysis.html no longer builds a raw 'Sourced via <source_type>' string", () => {
  const src = readPublic("rook-job-analysis.html");
  assert.ok(!src.includes("'Sourced via ' + job.source_type"), "must never concatenate the raw source_type directly into customer-facing text");
  assert.ok(src.includes("friendlySourceLabel"), "must route through the friendly label function instead");
});
test("friendlySourceLabel maps a genuine ATS/employer-site source to a customer-facing benefit, not a technical name", () => {
  const src = readPublic("rook-job-analysis.html");
  const match = src.match(/function friendlySourceLabel\(sourceType\) \{[\s\S]*?\n\}/);
  assert.ok(match, "function must exist");
  const fn = new Function("sourceType", match[0].replace(/^function friendlySourceLabel\(sourceType\) \{/, "").replace(/\}$/, ""));
  assert.strictEqual(fn("workday"), "Verified on the employer's career site");
  assert.strictEqual(fn("greenhouse"), "Verified on the employer's career site");
  assert.strictEqual(fn("recruiter_posted"), "Posted by Recruiter");
  assert.strictEqual(fn("agency_aggregated"), "Staffing Agency");
});

console.log("\n=== REGRESSION: homepage hero trial CTA ===");
test("the homepage hero's primary CTA is the exact requested trial wording and opens signup mode directly", () => {
  const src = readPublic("index.html");
  assert.ok(src.includes(">START YOUR 3-DAY FREE TRIAL<"), "must use the exact requested CTA text");
  assert.ok(src.includes('href="rook-onboarding-v2.html" class="btn btn-primary"'), "the primary CTA must point to rook-onboarding-v2.html (Stage 2 entry flow)");
  assert.ok(src.includes("Medical sales jobs only") && src.includes("Cancel anytime"), "supporting line must be present in the hero");
});
test("the old 'Find My Matches' hero CTA text and its plain (login-tab) destination are both gone", () => {
  const src = readPublic("index.html");
  assert.ok(!src.includes('href="rook-login.html" class="btn btn-primary">Find My Matches'), "the old CTA text/destination pairing must no longer exist in the hero");
});

console.log("\n=== REGRESSION: trial banner strip CTA now opens signup mode ===");
test("rook-trial-banner.js's 'Start Free Trial' CTA opens Create Account directly", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "rook-trial-banner.js"), "utf8");
  assert.ok(src.includes("cta.href = 'rook-login.html?mode=signup';"));
});

console.log("\n=== REGRESSION: stable signup-mode routing on the login page ===");
test("rook-login.html reads ?mode=signup and switches to the signup tab, without stripping the query param (so a refresh preserves it)", () => {
  const src = readPublic("rook-login.html");
  const modeBlock = src.match(/if \(new URLSearchParams\(window\.location\.search\)\.get\('mode'\) === 'signup'\) \{[\s\S]*?\}/);
  assert.ok(modeBlock, "the mode=signup handling block must exist");
  assert.ok(modeBlock[0].includes("switchTab('signup')"));
  assert.ok(!modeBlock[0].includes("replaceState"), "unlike the verified=1 handler, this must NOT strip the query param from the URL");
});
test("existing Log In links (plain rook-login.html, no mode param) are unaffected — default tab is still Log In", () => {
  const src = readPublic("rook-login.html");
  assert.ok(src.includes('<div class="tab active" id="tabSignin"'), "sign-in must remain the default active tab when no mode param is present");
});
test("the Create Account panel uses the exact requested headline, description, and button copy", () => {
  const src = readPublic("rook-login.html");
  assert.ok(src.includes("<h2>Start your 3-day free trial</h2>"));
  assert.ok(src.includes("Create your profile to see employers, complete job details, and personalized ROOK matches."));
  assert.ok(src.includes("Opportunities from 237+ employer career sites"));
  assert.ok(src.includes("Three days of full ROOK access"));
  assert.ok(src.includes(">CREATE ACCOUNT &amp; START FREE TRIAL<"));
});
test("no price, trial duration, or Stripe-related text was introduced into the signup panel", () => {
  const src = readPublic("rook-login.html");
  const signupPanelMatch = src.match(/<div id="panelSignup"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(signupPanelMatch, "signup panel must exist");
  assert.ok(!signupPanelMatch[0].includes("$29"), "must not introduce pricing into the signup panel");
});

console.log("\n=== REGRESSION: mobile filters toggle button CSS ordering ===");
test("the .mobile-filters-toggle base (display:none) rule appears BEFORE its max-width:900px override, not after — the reverse order silently loses the override regardless of viewport", () => {
  const src = readPublic("rook-search.html");
  const lines = src.split("\n");
  const baseLineIndex = lines.findIndex((l) => l.includes(".mobile-filters-toggle{") && !l.includes("display:flex"));
  const overrideLineIndex = lines.findIndex((l) => l.includes(".mobile-filters-toggle{display:flex;}"));
  assert.ok(baseLineIndex !== -1, "base rule must exist");
  assert.ok(overrideLineIndex !== -1, "media query override must exist");
  assert.ok(baseLineIndex < overrideLineIndex, "base display:none rule must come before the media-query display:flex override in source order");
});

console.log(`\n${passCount} passed, ${failCount} failed\n`);
if (failCount > 0) process.exit(1);
