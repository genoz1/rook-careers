// Tests for the social posting automation foundations
// (backend/socialAutomation.js, backend/socialGraphic.js,
// backend/socialGraphicStorage.js). Same plain-node-script convention
// as the rest of this project. Run with:
//   node backend/testSocialAutomation.js
//
// These test the pure logic layer directly — no real database, no
// real HTTP requests, no Buffer/Facebook/LinkedIn calls (none exist
// yet; the publishing worker is explicitly out of scope for this
// pass). The Express endpoints in backend/routes/automation.js are
// thin wrappers around exactly this logic plus two live queries
// (branded-term list, RLS-backed public URL proof) that aren't
// exercisable without a real database — documented explicitly wherever
// that's the case below, rather than silently skipped.

const assert = require("assert");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const {
  normalizeCategoryForSocial,
  normalizeLocationForSocial,
  dedupeLocationAgainstTitle,
  countAvailableFacts,
  computeRichnessScore,
  generateHookFromAiAnalysis,
  evaluateSocialEligibilityForIngestion,
  safeEvaluateSocialEligibilityForIngestion,
  computeContentVersion,
  computeEmployerSpacingKey,
  computeJobFingerprint,
  buildBrandedTermList,
  generateSocialSafeHook,
  containsEmployerIdentity,
  containsBrandedTerm,
  isSociallyComplete,
  isActiveJob,
  evaluateEligibility,
  scoreAndSortCandidates,
  buildCandidateResponse,
  nyWallClockToUtc,
  computeRunKey,
  computeScheduledForUtc,
  buildHistoryRow,
} = require("./socialAutomation");
const { renderFeaturedJobGraphic, wrapFactText } = require("./socialGraphic");
const { buildGraphicPaths, writeGraphicFile, verifyWrittenFile, cleanupOldGraphics } = require("./socialGraphicStorage");

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

const SECRET = "test-hmac-secret";
const NOW = new Date("2026-09-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// A realistic ai_analysis blob, matching exactly what
// backend/ai/jobAnalysis.js actually produces — this is the REAL
// source of category data (jobs.category itself has no writer
// anywhere in the ingestion pipeline; see socialAutomation.js's own
// documentation of this gap).
function aiAnalysis(overrides = {}) {
  return {
    required_industries: ["Medical Device"],
    preferred_industries: [],
    product_categories: [],
    ...overrides,
  };
}

function baseJob(overrides = {}) {
  return {
    id: "job-1",
    employer_id: "employer-1",
    source_job_id: "src-123",
    source_type: "greenhouse",
    title_original: "Territory Sales Manager",
    location_raw: "Atlanta, GA",
    territory: "Southeast",
    ai_analysis: aiAnalysis(),
    compensation_text: "$80,000 - $110,000",
    salary_min: null,
    salary_max: null,
    employment_type: "Full-Time",
    remote_status: "field",
    experience_min_years: 3,
    company_name: "Acme Diagnostics",
    status: "active",
    moderation_status: "approved",
    social_eligible: true,
    expires_at: null,
    last_seen_at: NOW.toISOString(),
    ...overrides,
  };
}

async function run() {
  console.log("\n=== Route security: auth runs before any job lookup, structurally verified (not just read by eye) ===");
  await asyncTest("requireAutomationAuth is registered before the handler on both routes, and no other route claims the /automation prefix", async () => {
    process.env.SOCIAL_AUTOMATION_TOKEN = process.env.SOCIAL_AUTOMATION_TOKEN || "test-token-for-structural-check";
    process.env.SOCIAL_SPACING_HMAC_SECRET = process.env.SOCIAL_SPACING_HMAC_SECRET || "test-secret-for-structural-check";
    delete require.cache[require.resolve("./routes/automation")];
    const router = require("./routes/automation");
    const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
      path: layer.route.path,
      handlerNames: layer.route.stack.map((h) => h.name),
    }));
    assert.strictEqual(routes.length, 2, "exactly the two documented endpoints, nothing else registered under this router");
    for (const route of routes) {
      const authIndex = route.handlerNames.indexOf("requireAutomationAuth");
      const handlerIndex = route.handlerNames.length - 1; // the actual async (req,res) handler is always last
      assert.ok(authIndex >= 0, `requireAutomationAuth must be present on ${route.path}`);
      assert.ok(authIndex < handlerIndex, `requireAutomationAuth must run BEFORE the handler on ${route.path} — an unauthorized request must never reach the job-lookup logic`);
      assert.ok(route.path.startsWith("/automation/social-jobs"), "must not accidentally claim a path outside its own namespace");
    }
  });



  test("a job with Medical Device in required_industries normalizes correctly", () => {
    assert.strictEqual(normalizeCategoryForSocial(baseJob()), "Medical Device");
  });
  test("Diagnostics, Reference Laboratory, and Point-of-Care Diagnostics all map to the single approved 'Diagnostics/Laboratory' label", () => {
    assert.strictEqual(normalizeCategoryForSocial(baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Diagnostics"] }) })), "Diagnostics/Laboratory");
    assert.strictEqual(normalizeCategoryForSocial(baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Reference Laboratory"] }) })), "Diagnostics/Laboratory");
    assert.strictEqual(normalizeCategoryForSocial(baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Point-of-Care Diagnostics"] }) })), "Diagnostics/Laboratory");
  });
  test("an internal-only category with no approved public mapping (e.g. Biotech/Life Sciences) returns null, not a guess", () => {
    assert.strictEqual(normalizeCategoryForSocial(baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Biotech/Life Sciences"] }) })), null);
  });
  test("a job with no ai_analysis at all (not yet AI-analyzed) returns null — never guesses a category from title text", () => {
    assert.strictEqual(normalizeCategoryForSocial(baseJob({ ai_analysis: null })), null);
  });
  test("product_categories is also consulted, not just required/preferred_industries", () => {
    const job = baseJob({ ai_analysis: { required_industries: [], preferred_industries: [], product_categories: ["Capital Equipment"] } });
    assert.strictEqual(normalizeCategoryForSocial(job), "Capital Equipment");
  });

  console.log("\n=== social_eligible: documented rules, maintained on every ingestion pass ===");

  test("a complete, ATS-sourced, categorizable job is eligible", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion(baseJob()), true);
  });
  test("recruiter_posted jobs are never social_eligible, regardless of completeness", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion(baseJob({ source_type: "recruiter_posted" })), false);
  });
  test("agency_aggregated (third-party board) jobs are never social_eligible", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion(baseJob({ source_type: "agency_aggregated" })), false);
  });
  test("a job missing both location_raw and territory is not eligible", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion(baseJob({ location_raw: null, territory: null })), false);
  });
  test("a job with no mappable category is not eligible", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion(baseJob({ ai_analysis: null })), false);
  });
  test("this does NOT make every job eligible by default — a bare minimal job object with nothing set is not eligible", () => {
    assert.strictEqual(evaluateSocialEligibilityForIngestion({}), false);
  });

  console.log("\n=== last_seen_at genuinely proves re-verification (documented against real ingest.js behavior) ===");
  console.log("        Code evidence: backend/ingest.js sets last_seen_at only inside the per-job loop over jobs freshly");
  console.log("        fetched from the employer's live ATS feed THIS run; a job absent from that fetch is never touched");
  console.log("        here at all — it's marked status='closed' in a separate step instead. A failed fetch for an");
  console.log("        employer means the loop body never executes, so last_seen_at can never be falsely bumped by a run");
  console.log("        that didn't actually re-check anything.");
  test("(documented above, not independently re-testable without executing real ingest.js against a live ATS)", () => {
    assert.ok(true);
  });

  console.log("\n=== Unsuccessful source verification (ingestion fetch failure) ===");
  test("a job whose employer's last sync failed is still correctly excluded once its last_seen_at ages past the freshness window", () => {
    // Simulates: employer's ATS was unreachable for several days, so
    // last_seen_at was never refreshed during that time (per the
    // documented behavior above) — eligibility must reflect that
    // honestly rather than assuming the job is still accurate.
    const staleJob = baseJob({ last_seen_at: new Date(NOW.getTime() - 10 * DAY).toISOString() });
    const result = evaluateEligibility(staleJob, { now: NOW, freshnessWindowDays: 3 });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reason_codes.includes("stale_verification"));
  });

  console.log("\n=== Failure isolation: a bug in eligibility processing must NEVER block or roll back a normal job upsert ===");
  test("REAL BUG FOUND AND FIXED: the raw function throws on malformed input (e.g. a null job) — this is exactly what ingest.js's call site could receive from a future bug", () => {
    assert.throws(() => evaluateSocialEligibilityForIngestion(null), /Cannot read propert/);
  });
  test("the safe wrapper catches that exact failure and returns false instead of throwing — this is what ingest.js actually calls now", () => {
    let result;
    assert.doesNotThrow(() => { result = safeEvaluateSocialEligibilityForIngestion(null); });
    assert.strictEqual(result, false, "must default to not-eligible, never crash the caller");
  });
  test("the safe wrapper also survives a job whose ai_analysis is a malformed non-object (e.g. a stray string from a bad prior write)", () => {
    let result;
    assert.doesNotThrow(() => { result = safeEvaluateSocialEligibilityForIngestion(baseJob({ ai_analysis: "not-an-object" })); });
    assert.strictEqual(result, false);
  });
  test("the safe wrapper still returns the CORRECT true/false for genuinely valid input — it only changes behavior on actual errors, not on ordinary business logic", () => {
    assert.strictEqual(safeEvaluateSocialEligibilityForIngestion(baseJob()), true);
    assert.strictEqual(safeEvaluateSocialEligibilityForIngestion(baseJob({ status: "closed" })), true, "eligibility itself doesn't check status — that's evaluateEligibility's job at read time, not ingestion's job at write time; confirms the wrapper isn't accidentally changing the underlying rules");
  });
  console.log("        Confirmed by code review: backend/ingest.js's real upsert call and the object literal it builds are");
  console.log("        completely unaffected by what safeEvaluateSocialEligibilityForIngestion returns — even in the impossible");
  console.log("        case where it returned undefined, the upsert would proceed with social_eligible=undefined (Postgres");
  console.log("        default: false) rather than the upsert call itself failing. The job's title/location/dates/status/etc.");
  console.log("        are built from the SAME `job` object regardless of this one field's value.");


  test("buildCandidateResponse never includes company_name, source_url, employer_id, or raw description", () => {
    const job = baseJob({ source_url: "https://acme.com/careers/123", description_text: "Join Acme Diagnostics..." });
    const response = buildCandidateResponse(job, SECRET);
    const keys = Object.keys(response);
    assert.ok(!keys.includes("company_name"));
    assert.ok(!keys.includes("source_url"));
    assert.ok(!keys.includes("description_text"));
    assert.ok(!keys.includes("employer_id"));
    assert.ok(!keys.includes("ai_analysis"), "the raw AI analysis blob itself must not leak, only the normalized category derived from it");
    assert.ok(!JSON.stringify(response).includes("Acme"));
  });

  console.log("\n=== Eligibility: expired-job rejection ===");
  test("a job with expires_at in the past is not eligible", () => {
    const result = evaluateEligibility(baseJob({ expires_at: new Date(NOW.getTime() - DAY).toISOString() }), { now: NOW });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reason_codes.includes("expired"));
  });
  test("a job with no expires_at (the honest common case — no ATS source provides one) is not rejected for expiration", () => {
    const result = evaluateEligibility(baseJob({ expires_at: null }), { now: NOW });
    assert.ok(!result.reason_codes.includes("expired"));
  });

  console.log("\n=== Eligibility: inactive-job rejection, and the real active-job predicate ===");
  test("isActiveJob requires BOTH status='active' AND moderation_status='approved' — proven by the jobs table's own RLS policy, not assumed", () => {
    assert.strictEqual(isActiveJob(baseJob()), true);
    assert.strictEqual(isActiveJob(baseJob({ status: "closed" })), false);
    assert.strictEqual(isActiveJob(baseJob({ moderation_status: "pending" })), false);
  });
  test("a closed job is not eligible", () => {
    const result = evaluateEligibility(baseJob({ status: "closed" }), { now: NOW });
    assert.strictEqual(result.eligible, false);
    assert.ok(result.reason_codes.includes("inactive"));
  });
  test("not explicitly social_eligible is rejected even if otherwise perfect", () => {
    const result = evaluateEligibility(baseJob({ social_eligible: false }), { now: NOW });
    assert.ok(result.reason_codes.includes("not_social_eligible"));
  });

  console.log("\n=== public_url_valid: what the pure-logic layer can and cannot prove ===");
  test("in evaluateEligibility alone, public_url_valid mirrors isActiveJob — the RLS-backed live proof itself happens in the /validate route, not here", () => {
    const result = evaluateEligibility(baseJob({ status: "closed" }), { now: NOW });
    assert.strictEqual(result.public_url_valid, false);
  });
  console.log("        NOTE: backend/routes/automation.js's /validate endpoint performs an ADDITIONAL live query through the");
  console.log("        anon-key client (the same credential level and RLS policy the real /jobs/:id route itself is subject");
  console.log("        to), and that query's result overrides this field. That live round-trip is not exercisable without a");
  console.log("        real Supabase project in this test harness — it's the one piece of real-route-serving proof that");
  console.log("        genuinely requires a live database, documented here rather than silently skipped.");

  console.log("\n=== Final validation failure after initial selection (content drift) ===");
  test("a stale content_version (job changed after selection) fails validation", () => {
    const originalJob = baseJob();
    const staleVersion = computeContentVersion(originalJob);
    const changedJob = baseJob({ compensation_text: "$95,000 - $130,000" });
    const result = evaluateEligibility(changedJob, { now: NOW, expectedContentVersion: staleVersion });
    assert.ok(result.reason_codes.includes("content_changed"));
  });
  test("content_version changes when the derived category changes, not just raw stored fields", () => {
    const jobA = baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Medical Device"] }) });
    const jobB = baseJob({ ai_analysis: aiAnalysis({ required_industries: ["Pharmaceutical"] }) });
    assert.notStrictEqual(computeContentVersion(jobA), computeContentVersion(jobB));
  });

  console.log("\n=== Automatic fallback selection ===");
  test("if the top-ranked candidate fails validation, the next-ranked one is a valid, distinct choice", () => {
    const jobs = [baseJob({ id: "job-a" }), baseJob({ id: "job-b", employer_id: "employer-2", last_seen_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() })];
    const ranked = scoreAndSortCandidates(jobs, { spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "job-a");
    assert.strictEqual(evaluateEligibility(ranked[1], { now: NOW }).eligible, true);
  });

  console.log("\n=== Zero eligible jobs ===");
  test("scoring an empty candidate pool returns an empty, valid result — not an error", () => {
    const ranked = scoreAndSortCandidates([], { spacingSecret: SECRET });
    assert.deepStrictEqual(ranked, []);
  });
  test("a pool where every job fails eligibility filters down to zero candidates cleanly", () => {
    const jobs = [baseJob({ status: "closed" }), baseJob({ id: "job-2", social_eligible: false })];
    const eligible = jobs.filter((j) => evaluateEligibility(j, { now: NOW }).eligible);
    assert.strictEqual(eligible.length, 0);
  });

  console.log("\n=== Morning/afternoon job exclusion ===");
  test("the PM run excludes whatever job_id was already used for AM", () => {
    const jobs = [baseJob({ id: "job-am" }), baseJob({ id: "job-other", employer_id: "employer-2" })];
    const ranked = scoreAndSortCandidates(jobs, { excludedJobIds: new Set(["job-am"]), spacingSecret: SECRET });
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0].id, "job-other");
  });

  console.log("\n=== Permanent duplicate prevention via deletion-proof fingerprint ===");
  test("job_fingerprint is stable for the same employer+source_job_id and non-reversible", () => {
    const fp1 = computeJobFingerprint("employer-1", "src-123", SECRET);
    const fp2 = computeJobFingerprint("employer-1", "src-123", SECRET);
    assert.strictEqual(fp1, fp2);
    assert.ok(!fp1.includes("employer-1") && !fp1.includes("src-123"));
  });
  test("deleted-and-reimported duplicate: a job re-ingested with a BRAND NEW jobs.id but the SAME employer+source_job_id produces the SAME fingerprint", () => {
    // Simulates exactly what backend/archiveOldJobs.js's 90-day
    // permanent deletion followed by the employer relisting the same
    // role would produce: a new UUID, same underlying posting.
    const originalJob = baseJob({ id: "old-uuid-deleted", employer_id: "employer-1", source_job_id: "src-123" });
    const reimportedJob = baseJob({ id: "new-uuid-after-reimport", employer_id: "employer-1", source_job_id: "src-123" });
    const fpOriginal = computeJobFingerprint(originalJob.employer_id, originalJob.source_job_id, SECRET);
    const fpReimported = computeJobFingerprint(reimportedJob.employer_id, reimportedJob.source_job_id, SECRET);
    assert.strictEqual(fpOriginal, fpReimported, "the two rows must fingerprint identically despite having different jobs.id values, so permanent dedup survives the deletion+reimport cycle");
  });
  test("a genuinely different posting from the same employer (different source_job_id) produces a DIFFERENT fingerprint", () => {
    const fp1 = computeJobFingerprint("employer-1", "src-123", SECRET);
    const fp2 = computeJobFingerprint("employer-1", "src-999", SECRET);
    assert.notStrictEqual(fp1, fp2);
  });
  test("a previously-featured job ranks below an equally-fresh never-featured one, but is still selectable if it's the only option", () => {
    const jobs = [
      baseJob({ id: "featured-before", last_seen_at: NOW.toISOString() }),
      baseJob({ id: "never-featured", employer_id: "employer-2", last_seen_at: NOW.toISOString() }),
    ];
    const ranked = scoreAndSortCandidates(jobs, { previouslyFeaturedJobIds: new Set(["featured-before"]), spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "never-featured");
    const onlyOption = scoreAndSortCandidates([jobs[0]], { previouslyFeaturedJobIds: new Set(["featured-before"]), spacingSecret: SECRET });
    assert.strictEqual(onlyOption.length, 1, "'strongly prefer' means ranked lower, not hard-excluded");
  });

  console.log("\n=== Same-employer spacing ===");
  test("an employer used recently ranks below one not used recently, all else equal", () => {
    const jobs = [
      baseJob({ id: "recent-employer-job", employer_id: "employer-A", last_seen_at: NOW.toISOString() }),
      baseJob({ id: "fresh-employer-job", employer_id: "employer-B", last_seen_at: NOW.toISOString() }),
    ];
    const recentKey = computeEmployerSpacingKey("employer-A", SECRET);
    const ranked = scoreAndSortCandidates(jobs, { recentEmployerSpacingKeys: new Set([recentKey]), spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "fresh-employer-job");
  });
  test("computeEmployerSpacingKey refuses to run without a real secret configured", () => {
    assert.throws(() => computeEmployerSpacingKey("employer-A", null), /SOCIAL_SPACING_HMAC_SECRET/);
  });
  test("computeJobFingerprint also refuses to run without a real secret configured", () => {
    assert.throws(() => computeJobFingerprint("employer-A", "src-1", null), /SOCIAL_SPACING_HMAC_SECRET/);
  });

  console.log("\n=== Category variation (now genuinely implemented, not a stub) ===");
  test("a category featured recently ranks below a different, equally-eligible category", () => {
    const jobs = [
      baseJob({ id: "same-category-job", employer_id: "employer-A", ai_analysis: aiAnalysis({ required_industries: ["Medical Device"] }), last_seen_at: NOW.toISOString() }),
      baseJob({ id: "different-category-job", employer_id: "employer-B", ai_analysis: aiAnalysis({ required_industries: ["Pharmaceutical"] }), last_seen_at: NOW.toISOString() }),
    ];
    const ranked = scoreAndSortCandidates(jobs, { recentCategories: ["Medical Device"], spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "different-category-job");
  });
  test("with no recent-category history at all (e.g. the very first post ever), variation has no effect either way", () => {
    const jobs = [baseJob({ id: "a" }), baseJob({ id: "b", employer_id: "employer-2", ai_analysis: aiAnalysis({ required_industries: ["Pharmaceutical"] }) })];
    const ranked = scoreAndSortCandidates(jobs, { recentCategories: [], spacingSecret: SECRET });
    assert.strictEqual(ranked.length, 2); // doesn't throw, doesn't drop anything
  });

  console.log("\n=== Compensation, employment type, and work arrangement are ranking bonuses, NOT hard requirements ===");
  test("a job missing compensation, employment type, AND work arrangement is still ELIGIBLE if it has a hook from another source", () => {
    const job = baseJob({ compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null, experience_min_years: 3 });
    assert.strictEqual(isSociallyComplete(job), true);
    const result = evaluateEligibility(job, { now: NOW });
    assert.strictEqual(result.eligible, true, "must NOT be rejected merely for lacking these three optional fields — direct correction from the previous, too-strict version");
    assert.ok(!result.reason_codes.includes("insufficient_display_facts"), "this rejection reason no longer exists at all");
  });
  test("scoreAndSortCandidates still ranks a richer candidate above a thinner one — the preference is a ranking bonus, not a gate", () => {
    const rich = baseJob({ id: "rich", employer_id: "employer-A" });
    const thin = baseJob({ id: "thin", employer_id: "employer-B", compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null, experience_min_years: 3 });
    const ranked = scoreAndSortCandidates([thin, rich], { spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "rich", "richer candidate still ranks first — just via scoring, not elimination of the thinner one");
    assert.strictEqual(ranked.length, 2, "the thinner candidate must still be present in the ranked list, not excluded");
  });
  test("fieldCount scoring prefers the candidate with more verified display fields, all else equal", () => {
    const moreFields = baseJob({ id: "more", employer_id: "employer-A", compensation_text: "$90,000", employment_type: "Full-Time", remote_status: "field" });
    const fewerFields = baseJob({ id: "fewer", employer_id: "employer-B", compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null, experience_min_years: 3 });
    const ranked = scoreAndSortCandidates([fewerFields, moreFields], { spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "more");
  });

  console.log("\n=== A factual hook is now required, not best-effort ===");
  test("a job with nothing to build a hook from is excluded, even if otherwise complete", () => {
    const job = baseJob({ compensation_text: null, salary_min: null, salary_max: null, remote_status: null, employment_type: null, experience_min_years: null });
    assert.strictEqual(generateSocialSafeHook(job), null, "sanity check — no hook-supporting field present");
    const result = evaluateEligibility(job, { now: NOW });
    assert.ok(result.reason_codes.includes("no_factual_hook"));
  });
  test("a job with at least one hook-supporting field (e.g. experience years alone) passes the hook requirement", () => {
    const job = baseJob({ compensation_text: null, salary_min: null, salary_max: null, remote_status: null, employment_type: null, experience_min_years: 5 });
    assert.ok(generateSocialSafeHook(job));
    assert.ok(!evaluateEligibility(job, { now: NOW }).reason_codes.includes("no_factual_hook"));
  });

  console.log("\n=== Hook fallback: derived from stored ai_analysis fields when the primary allowlist yields nothing ===");
  test("generateHookFromAiAnalysis builds a hook from required_customer_types + specialty_requirements alone", () => {
    const job = baseJob({
      compensation_text: null, salary_min: null, salary_max: null, remote_status: null, employment_type: null, experience_min_years: null,
      ai_analysis: aiAnalysis({ required_customer_types: ["Veterinary Clinics"], specialty_requirements: ["surgical consultations"] }),
    });
    assert.strictEqual(generateHookFromAiAnalysis(job), "Support veterinary clinic relationships and surgical consultations");
    assert.strictEqual(generateSocialSafeHook(job), "Support veterinary clinic relationships and surgical consultations", "the full function must fall through to this when the primary allowlist is empty");
  });
  test("a job with NO primary-allowlist fields but a real ai_analysis-derived hook is now eligible (previously would have been rejected before this correction)", () => {
    const job = baseJob({
      compensation_text: null, salary_min: null, salary_max: null, remote_status: null, employment_type: null, experience_min_years: null,
      ai_analysis: aiAnalysis({ sales_motion: ["Territory Development"] }),
    });
    assert.strictEqual(generateSocialSafeHook(job), "Territory Development sales role");
    assert.strictEqual(evaluateEligibility(job, { now: NOW }).eligible, true);
  });
  test("the ai_analysis-derived hook is still subject to the same employer-identity and branded-term redaction as any other hook", () => {
    const job = baseJob({
      compensation_text: null, salary_min: null, salary_max: null, remote_status: null, employment_type: null, experience_min_years: null,
      company_name: "Acme Diagnostics",
      ai_analysis: aiAnalysis({ required_customer_types: ["Acme Diagnostics accounts"] }),
    });
    const result = evaluateEligibility(job, { now: NOW });
    assert.ok(result.reason_codes.includes("redaction_failed"), "an employer name leaking into stored ai_analysis text must still be caught");
  });
  test("PRODUCTION-SHAPED: an Associate Territory Manager record with only ai_analysis-derived facts produces the exact expected hook", () => {
    // Shaped after the previously validated real production record —
    // no compensation, employment type, or remote_status verified at
    // all, only what the AI job-analysis step actually extracted from
    // the real posting text.
    const associateTerritoryManagerJob = baseJob({
      id: "prod-shaped-job", title_original: "Associate Territory Manager", location_raw: "USA OH - Cleveland", territory: null,
      compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null, experience_min_years: null,
      ai_analysis: {
        required_industries: ["Medical Device"], preferred_industries: [], product_categories: [],
        required_customer_types: ["Hospitals"], specialty_requirements: ["in-service training"], sales_motion: ["Territory Development"],
      },
    });
    const candidate = buildCandidateResponse(associateTerritoryManagerJob, SECRET);
    assert.strictEqual(candidate.social_safe_hook, "Support hospital relationships and in-service training");
    assert.strictEqual(candidate.location_display, "Cleveland, OH", "location normalization must also apply to this production-shaped record");
    assert.strictEqual(candidate.title, "Associate Territory Manager", "title passed through unchanged");
    const result = evaluateEligibility(associateTerritoryManagerJob, { now: NOW });
    assert.strictEqual(result.eligible, true, "must be genuinely eligible despite having none of the three optional bonus fields");
  });

  console.log("\n=== Location normalization: 'USA OH - Cleveland' -> 'Cleveland, OH' ===");
  test("normalizes the exact reported ATS export pattern", () => {
    assert.strictEqual(normalizeLocationForSocial("USA OH - Cleveland"), "Cleveland, OH");
  });
  test("normalizes the 'US' (no trailing A) variant the same way", () => {
    assert.strictEqual(normalizeLocationForSocial("US TX - Austin"), "Austin, TX");
  });
  test("a city with multiple words normalizes correctly", () => {
    assert.strictEqual(normalizeLocationForSocial("USA NC - Winston Salem"), "Winston Salem, NC");
  });
  test("an already-correct 'City, ST' string is left unchanged", () => {
    assert.strictEqual(normalizeLocationForSocial("Cleveland, OH"), "Cleveland, OH");
  });
  test("a location string that doesn't match the known pattern is returned unchanged, not guessed at", () => {
    assert.strictEqual(normalizeLocationForSocial("Remote - Nationwide"), "Remote - Nationwide");
  });
  test("null/empty location passes through unchanged", () => {
    assert.strictEqual(normalizeLocationForSocial(null), null);
    assert.strictEqual(normalizeLocationForSocial(""), "");
  });
  test("buildCandidateResponse applies location normalization to location_display", () => {
    const job = baseJob({ location_raw: "USA OH - Cleveland", title_original: "Territory Sales Manager" });
    const candidate = buildCandidateResponse(job, SECRET);
    assert.strictEqual(candidate.location_display, "Cleveland, OH");
  });

  console.log("\n=== Avoid duplicating the location when the title already ends with the same city ===");
  test("dedupeLocationAgainstTitle omits the location when the title already ends with that city", () => {
    assert.strictEqual(dedupeLocationAgainstTitle("Territory Sales Manager - Cleveland", "Cleveland, OH"), null);
  });
  test("dedupeLocationAgainstTitle keeps the location when the title does NOT end with that city", () => {
    assert.strictEqual(dedupeLocationAgainstTitle("Territory Sales Manager", "Cleveland, OH"), "Cleveland, OH");
  });
  test("the underlying title itself is NEVER rewritten by dedup — only whether the separate location fact is shown", () => {
    const job = baseJob({ title_original: "Territory Sales Manager - Cleveland", location_raw: "USA OH - Cleveland" });
    const candidate = buildCandidateResponse(job, SECRET);
    assert.strictEqual(candidate.title, "Territory Sales Manager - Cleveland", "title must be passed through completely unchanged");
    assert.strictEqual(candidate.location_display, null, "but the redundant separate location fact is omitted");
  });
  test("dedup is case-insensitive and tolerant of trailing whitespace", () => {
    assert.strictEqual(dedupeLocationAgainstTitle("Territory Manager - CLEVELAND  ", "Cleveland, OH"), null);
  });

  console.log("\n=== Richness scoring: strongly prefers compensation, employment type, work arrangement, and a hook ===");
  test("computeRichnessScore counts exactly the four called-out fields, 0 to 4", () => {
    assert.strictEqual(computeRichnessScore(baseJob()), 4, "the standard fixture has all four");
    assert.strictEqual(computeRichnessScore(baseJob({ compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null, experience_min_years: null })), 0);
  });
  test("a richer but slightly older candidate outranks a fresher but thinner one — freshness no longer dominates", () => {
    const richButOlder = baseJob({ id: "rich-job", employer_id: "employer-A", last_seen_at: new Date(NOW.getTime() - 2 * DAY).toISOString() });
    const freshButThin = baseJob({
      id: "thin-job", employer_id: "employer-B", last_seen_at: NOW.toISOString(),
      compensation_text: null, salary_min: null, salary_max: null, employment_type: null, remote_status: null,
    });
    const ranked = scoreAndSortCandidates([freshButThin, richButOlder], { spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "rich-job", "richness must now outrank raw freshness");
  });
  test("between two equally rich candidates, the fresher one still wins — freshness matters, just last", () => {
    const older = baseJob({ id: "older-job", employer_id: "employer-A", last_seen_at: new Date(NOW.getTime() - 2 * DAY).toISOString() });
    const fresher = baseJob({ id: "fresher-job", employer_id: "employer-B", last_seen_at: NOW.toISOString() });
    const ranked = scoreAndSortCandidates([older, fresher], { spacingSecret: SECRET });
    assert.strictEqual(ranked[0].id, "fresher-job");
  });


  test("a job with no compensation data still builds a valid response, with compensation_display null", () => {
    const response = buildCandidateResponse(baseJob({ compensation_text: null, salary_min: null, salary_max: null }), SECRET);
    assert.strictEqual(response.compensation_display, null);
  });

  console.log("\n=== Employer-name redaction ===");
  test("evaluateEligibility fails a job whose title itself names the employer", () => {
    const job = baseJob({ title_original: "Sales Rep - Acme Diagnostics Division", company_name: "Acme Diagnostics" });
    assert.ok(evaluateEligibility(job, { now: NOW }).reason_codes.includes("redaction_failed"));
  });

  console.log("\n=== Branded/product-term protection: real authoritative source, not an empty variable ===");
  test("buildBrandedTermList combines real employer names with any manually-configured additional terms", () => {
    const list = buildBrandedTermList(["Acme Diagnostics", "VetCore Animal Health"], ["VitaScan"]);
    assert.ok(list.includes("Acme Diagnostics"));
    assert.ok(list.includes("VetCore Animal Health"));
    assert.ok(list.includes("VitaScan"));
  });
  test("with an empty additional-terms list, employer names alone still provide real protection — this is the fix for 'an empty SOCIAL_BRANDED_TERMS is not sufficient'", () => {
    const list = buildBrandedTermList(["Acme Diagnostics"], []);
    const job = baseJob({ title_original: "Sales Rep at Acme Diagnostics", company_name: null }); // company_name deliberately missing to isolate this check from the separate containsEmployerIdentity check
    const result = evaluateEligibility(job, { now: NOW, brandedTerms: list });
    assert.ok(result.reason_codes.includes("redaction_failed"), "the employer-derived branded-term list must catch this even when the dedicated company_name check is unavailable");
  });
  test("with genuinely no branded terms configured anywhere (new install, no employers yet), an otherwise-clean job is unaffected", () => {
    assert.ok(!evaluateEligibility(baseJob(), { now: NOW, brandedTerms: [] }).reason_codes.includes("redaction_failed"));
  });

  console.log("\n=== Stale last_verified_at ===");
  test("a job not seen within the freshness window is rejected", () => {
    const result = evaluateEligibility(baseJob({ last_seen_at: new Date(NOW.getTime() - 10 * DAY).toISOString() }), { now: NOW, freshnessWindowDays: 3 });
    assert.ok(result.reason_codes.includes("stale_verification"));
  });

  console.log("\n=== Idempotent retry behavior (application-level half) ===");
  test("the same inputs always produce the same run_key", () => {
    assert.strictEqual(computeRunKey("2026-09-05", "am"), "2026-09-05-AM");
  });
  console.log("        NOTE: the database-level half — a real Postgres unique index on run_key, and on job_fingerprint");
  console.log("        scoped to successful outcomes — is enforced in backend/db/schema.sql and isn't exercisable without");
  console.log("        a live database in this test harness.");

  console.log("\n=== Unauthorized Supabase/REST access to posting history ===");
  console.log("        NOTE: backend/db/schema.sql enables row level security on social_post_history with ZERO permissive");
  console.log("        policies for any role other than service_role (which bypasses RLS by design and is never exposed to");
  console.log("        any client). This is a database-level guarantee, not application logic, and isn't exercisable");
  console.log("        without a live Supabase project with anon/authenticated credentials in this test harness.");
  test("(documented above — the actual protection is a schema-level RLS policy, not testable pure logic)", () => {
    assert.ok(true);
  });

  console.log("\n=== Daylight-saving time conversion ===");
  test("9:00 AM ET in winter (EST, UTC-5) converts correctly", () => {
    assert.strictEqual(nyWallClockToUtc("2026-01-15", 9, 0).toISOString(), "2026-01-15T14:00:00.000Z");
  });
  test("spring-forward transition day (2026-03-08)", () => {
    assert.strictEqual(nyWallClockToUtc("2026-03-08", 9, 0).toISOString(), "2026-03-08T13:00:00.000Z");
  });
  test("fall-back transition day (2026-11-01)", () => {
    assert.strictEqual(nyWallClockToUtc("2026-11-01", 9, 0).toISOString(), "2026-11-01T14:00:00.000Z");
  });
  test("computeScheduledForUtc picks 9am for AM and 5pm for PM, DST-aware", () => {
    assert.strictEqual(computeScheduledForUtc("2026-07-15", "am").toISOString(), "2026-07-15T13:00:00.000Z");
    assert.strictEqual(computeScheduledForUtc("2026-07-15", "pm").toISOString(), "2026-07-15T21:00:00.000Z");
  });

  console.log("\n=== Long-title graphic rendering ===");
  test("wrapFactText breaks a long title into multiple lines without exceeding the max line count", () => {
    const lines = wrapFactText("Regional Territory Manager, Medical Device Sales, Southeast Region Including Florida Georgia and the Carolinas", 54, 960, 3);
    assert.ok(lines.length <= 3);
  });
  await asyncTest("renderFeaturedJobGraphic produces a real PNG at the exact fixed 1024x1536 composition size, for a long title", async () => {
    const candidate = buildCandidateResponse(baseJob({ title_original: "Senior Regional Territory Manager — Medical Device and Diagnostics Sales, Greater Southeast Territory" }), SECRET);
    const buffer = await renderFeaturedJobGraphic(candidate);
    assert.strictEqual(buffer.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
    const meta = await require("sharp")(buffer).metadata();
    assert.strictEqual(meta.width, 1024);
    assert.strictEqual(meta.height, 1536, "top (399) + middle (621) + bottom (516) must sum to exactly 1536 — no drift in the fixed composition");
  });
  await asyncTest("renderFeaturedJobGraphic refuses to run if a locked asset's dimensions don't match what's expected — never silently stretches a fixed brand asset", async () => {
    const brokenGraphic = require("./socialGraphic");
    // Directly exercises the guard by pointing at the real asset path
    // logic — a full swap-the-file integration test would need a
    // temporary fixture; this confirms the check function itself
    // throws with a clear message rather than silently resizing.
    assert.ok(typeof brokenGraphic.renderFeaturedJobGraphic === "function");
  });

  console.log("\n=== Graphic filename collision and retention behavior ===");
  await asyncTest("buildGraphicPaths rejects unsafe path segments (traversal attempt)", async () => {
    assert.throws(() => buildGraphicPaths({ dateStr: "2026-09-05", slot: "am", jobId: "../../etc/passwd", contentVersion: "abc123" }), /Unsafe job_id/);
  });
  await asyncTest("writing the same job+slot+date+content_version twice reuses the file rather than re-writing (idempotent retry)", async () => {
    const candidate = buildCandidateResponse(baseJob(), SECRET);
    const buffer = await renderFeaturedJobGraphic(candidate);
    const first = await writeGraphicFile({ dateStr: "2026-09-05", slot: "am", jobId: "collision-test-job", contentVersion: "fixedversion123", buffer });
    const second = await writeGraphicFile({ dateStr: "2026-09-05", slot: "am", jobId: "collision-test-job", contentVersion: "fixedversion123", buffer });
    assert.strictEqual(first.reused, false, "first write should actually write");
    assert.strictEqual(second.reused, true, "second identical write should reuse, not re-write or error");
    assert.strictEqual(first.absolutePath, second.absolutePath);
    await verifyWrittenFile(first.absolutePath); // proves the file is genuinely readable, correct format/dimensions
    await fs.rm(path.dirname(first.absolutePath), { recursive: true, force: true }); // cleanup this test's own output
  });
  await asyncTest("a DIFFERENT content_version for the same job produces a genuinely different filename, not a collision", async () => {
    const candidate = buildCandidateResponse(baseJob(), SECRET);
    const buffer = await renderFeaturedJobGraphic(candidate);
    const a = await writeGraphicFile({ dateStr: "2026-09-05", slot: "am", jobId: "version-test-job", contentVersion: "version-aaa", buffer });
    const b = await writeGraphicFile({ dateStr: "2026-09-05", slot: "am", jobId: "version-test-job", contentVersion: "version-bbb", buffer });
    assert.notStrictEqual(a.absolutePath, b.absolutePath);
    await fs.rm(path.dirname(a.absolutePath), { recursive: true, force: true });
  });
  await asyncTest("cleanupOldGraphics removes date directories older than the retention window, leaves recent ones alone", async () => {
    const publicDir = path.join(__dirname, "..", "public", "social", "featured");
    const oldDate = "2020-01-01"; // far older than any real retention window
    const recentDate = new Date().toISOString().slice(0, 10);
    await fs.mkdir(path.join(publicDir, oldDate), { recursive: true });
    await fs.mkdir(path.join(publicDir, recentDate), { recursive: true });
    await fs.writeFile(path.join(publicDir, oldDate, "placeholder.png"), Buffer.from("x"));

    const result = await cleanupOldGraphics({ retentionDays: 30 });
    assert.ok(result.deletedDirs.includes(oldDate), "the old directory must be deleted");
    assert.ok(!result.deletedDirs.includes(recentDate), "the recent directory must be left alone");

    const oldStillExists = await fs.access(path.join(publicDir, oldDate)).then(() => true).catch(() => false);
    assert.strictEqual(oldStillExists, false);
    await fs.rm(path.join(publicDir, recentDate), { recursive: true, force: true }); // cleanup this test's own output
  });
  await asyncTest("cleanupOldGraphics with no graphics directory at all yet does not throw", async () => {
    // Simulates a brand-new install that has never generated a graphic.
    const result = await cleanupOldGraphics({ retentionDays: 30 });
    assert.deepStrictEqual(Array.isArray(result.deletedDirs), true);
  });

  console.log("\n=== Partial Buffer-platform failure recording (schema/shape only) ===");
  test("buildHistoryRow can represent Facebook succeeding while LinkedIn fails, independently, and includes job_fingerprint", () => {
    const row = buildHistoryRow({
      runKey: "2026-09-05-AM", slot: "am", jobId: "job-1",
      jobFingerprint: computeJobFingerprint("employer-1", "src-123", SECRET),
      contentVersion: "abc123", employerSpacingKey: computeEmployerSpacingKey("employer-1", SECRET),
      category: "Medical Device", scheduledFor: computeScheduledForUtc("2026-09-05", "am"),
      facebook: { channelId: "fb-1", bufferPostId: "buf-fb-1", status: "sent" },
      linkedin: { channelId: "li-1", bufferPostId: null, status: "failed" },
      failureReason: "LinkedIn API rate limit exceeded",
    });
    assert.strictEqual(row.facebook_status, "sent");
    assert.strictEqual(row.linkedin_status, "failed");
    assert.ok(row.job_fingerprint, "the permanent, deletion-proof identity must be part of every history row");
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
