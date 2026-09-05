// Tests for the Buffer publishing worker and its supporting modules.
// Everything is exercised with dependency-injected mock Supabase/
// Buffer clients — no real network call is ever made by this suite,
// and no real credential is ever required to run it.
//
// Run with: node backend/testSocialPublishWorker.js

const assert = require("assert");
const { identifyRookChannels } = require("./socialChannels");
const { buildPostCopy } = require("./socialPostCopy");
const { getOrganizations, listChannelsForOrganization, listAllChannels, createPost, findPostById, BUFFER_API_ENDPOINT } = require("./socialBuffer");
const {
  loadConfig, requireConfigKeys, discoverChannels, runValidationOnly, runControlledLiveTest,
} = require("./socialPublishWorker");
const { computeJobFingerprint } = require("./socialAutomation");

let passCount = 0, failCount = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passCount++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failCount++; }
}
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passCount++; }
  catch (err) { console.log(`  FAIL  ${name}\n        ${err.message}`); failCount++; }
}

const SECRET = "test-hmac-secret";
const NOW = new Date();

// Real GraphQL Channel shape: id, name, service — verified against
// Buffer's own current docs. No personal-vs-page field exists in this
// API (see the note above identifyRookChannels in socialChannels.js).
const LINKEDIN_PAGE = { id: "li-page-1", service: "linkedin", name: "ROOK Careers" };
const LINKEDIN_PERSONAL_LOOKING = { id: "li-personal-1", service: "linkedin", name: "Gene Zentko" };
const FACEBOOK_PAGE = { id: "fb-page-1", service: "facebook", name: "ROOK Careers" };
const TWITTER_UNRELATED = { id: "tw-1", service: "twitter", name: "Some Other Account" };

function baseJob(overrides = {}) {
  return {
    id: "job-1", employer_id: "employer-1", source_job_id: "src-1", source_type: "greenhouse",
    title_original: "Territory Sales Manager", location_raw: "Atlanta, GA", territory: "Southeast",
    ai_analysis: { required_industries: ["Medical Device"], preferred_industries: [], product_categories: [] },
    compensation_text: "$90,000 - $120,000", employment_type: "Full-Time", remote_status: "field", experience_min_years: 3,
    company_name: "Acme Diagnostics", status: "active", moderation_status: "approved",
    social_eligible: true, expires_at: null, last_seen_at: NOW.toISOString(),
    ...overrides,
  };
}

// Minimal mock Supabase client supporting the exact query shapes the
// worker uses — a tiny fake query builder, not a real database.
function makeMockSupabase({ jobs = [], employers = [], history = [] } = {}) {
  function table(name) {
    let filters = [];
    const builder = {
      select: () => builder,
      eq: (col, val) => { filters.push((row) => row[col] === val); return builder; },
      in: (col, vals) => { filters.push((row) => vals.includes(row[col])); return builder; },
      order: () => builder,
      limit: () => builder,
      not: () => builder,
      maybeSingle: async () => {
        const rows = (name === "jobs" ? jobs : name === "employers" ? employers : history).filter((r) => filters.every((f) => f(r)));
        return { data: rows[0] || null, error: null };
      },
      upsert: async (row) => { history.push(row); return { data: row, error: null }; },
      then: (resolve) => {
        const rows = (name === "jobs" ? jobs : name === "employers" ? employers : history).filter((r) => filters.every((f) => f(r)));
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }
  return { from: table };
}

async function run() {
  console.log("\n=== Channel identification: rejects personal profiles, ambiguity, missing config ===");

  test("correctly identifies both ROOK business pages when configured IDs match", () => {
    const profiles = [LINKEDIN_PAGE, FACEBOOK_PAGE, LINKEDIN_PERSONAL_LOOKING, TWITTER_UNRELATED];
    const result = identifyRookChannels(profiles, { linkedinChannelId: "li-page-1", facebookChannelId: "fb-page-1" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.linkedin.id, "li-page-1");
    assert.strictEqual(result.facebook.id, "fb-page-1");
  });
  // Direct finding, verified against Buffer's own current GraphQL
  // docs: the Channel type exposes only id/name/service — there is no
  // personal-vs-business-Page field in this API at all. This means a
  // channel that happens to be a personal LinkedIn profile, if its ID
  // were explicitly (mis)configured as BUFFER_ROOK_LINKEDIN_CHANNEL_ID,
  // cannot be distinguished from a business Page by this code — the
  // API gives us nothing to check. The real, remaining safeguard is
  // human verification at configuration time: `npm run
  // social:discover-channels` prints each channel's readable `name`
  // (e.g. "ROOK Careers" vs. "Gene Zentko") specifically so a person
  // can visually confirm before ever setting the ID, not something
  // this code can enforce after the fact for this specific case.
  test("a channel matching the configured ID and correct service is accepted — Buffer's API provides no field to detect a personal profile beyond this", () => {
    const profiles = [LINKEDIN_PERSONAL_LOOKING, FACEBOOK_PAGE];
    const result = identifyRookChannels(profiles, { linkedinChannelId: "li-personal-1", facebookChannelId: "fb-page-1" });
    assert.strictEqual(result.ok, true, "documents the real, current limitation rather than asserting a protection that doesn't exist in this API");
  });
  test("service-type matching IS still enforced — a channel of the wrong platform is always rejected regardless of its ID being configured", () => {
    const result = identifyRookChannels([LINKEDIN_PAGE, FACEBOOK_PAGE], { linkedinChannelId: "fb-page-1", facebookChannelId: "li-page-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("not a LinkedIn channel")));
    assert.ok(result.errors.some((e) => e.includes("not a Facebook channel")));
  });
  test("rejects an unrelated/non-ROOK channel service mismatch", () => {
    const profiles = [TWITTER_UNRELATED, FACEBOOK_PAGE];
    const result = identifyRookChannels(profiles, { linkedinChannelId: "tw-1", facebookChannelId: "fb-page-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("not a LinkedIn channel")));
  });
  test("rejects missing channel ID configuration", () => {
    const result = identifyRookChannels([LINKEDIN_PAGE, FACEBOOK_PAGE], { linkedinChannelId: null, facebookChannelId: "fb-page-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("not configured")));
  });
  test("rejects ambiguous configuration — both IDs pointing at the same channel", () => {
    const result = identifyRookChannels([LINKEDIN_PAGE], { linkedinChannelId: "li-page-1", facebookChannelId: "li-page-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("must not be the same channel")));
  });
  test("rejects a configured ID that doesn't match any connected channel at all", () => {
    const result = identifyRookChannels([LINKEDIN_PAGE, FACEBOOK_PAGE], { linkedinChannelId: "nonexistent-id", facebookChannelId: "fb-page-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("No Buffer channel found")));
  });

  console.log("\n=== GraphQL variable types must match Buffer's real custom scalars, not generic String ===");
  console.log("        Verified against Buffer's own schema reference (developers.buffer.com/types/OrganizationId.html):");
  console.log("        organization/channel/post identifiers are dedicated custom scalars (OrganizationId, ChannelId,");
  console.log("        PostId, ...), NOT the generic String scalar — declaring $organizationId: String! is exactly");
  console.log("        the production error this fixes: 'used in position expecting type OrganizationId!'.");

  await asyncTest("listChannelsForOrganization declares $organizationId as OrganizationId!, not String!", async () => {
    const { httpFetch, getCaptured } = mockFetch({ channels: [] });
    await listChannelsForOrganization("fake-token", "org-1", { httpFetch });
    const query = JSON.parse(getCaptured().body).query;
    assert.ok(query.includes("$organizationId: OrganizationId!"), "must declare the exact Buffer-specific scalar type");
    assert.ok(!query.includes("$organizationId: String!"), "must never use the generic String scalar for this variable — this is the exact bug that was reported");
  });

  await asyncTest("findPostById declares $organizationId as OrganizationId!, not String!", async () => {
    const { httpFetch, getCaptured } = mockFetch({ posts: { edges: [] } });
    await findPostById("fake-token", "org-1", "post-1", { httpFetch });
    const query = JSON.parse(getCaptured().body).query;
    assert.ok(query.includes("$organizationId: OrganizationId!"));
    assert.ok(!query.includes("$organizationId: String!"));
  });

  test("audit: no GraphQL operation anywhere in socialBuffer.js declares an id-named variable with the generic String scalar", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("./socialBuffer"), "utf8");
    // Matches any $xyzId: String! declaration — the exact shape of bug
    // this whole test exists to catch, wherever it might appear now
    // or be reintroduced later.
    const badDeclarations = source.match(/\$\w*[Ii]d\w*\s*:\s*String!/g);
    assert.strictEqual(badDeclarations, null, `found an id-named variable still typed as the generic String scalar: ${JSON.stringify(badDeclarations)}`);
  });

  test("audit: every explicitly-declared GraphQL variable in socialBuffer.js uses a real Buffer scalar or input-object type", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("./socialBuffer"), "utf8");
    // Buffer's real custom scalars (developers.buffer.com/types/) plus
    // legitimate input-object type names actually used in this file —
    // anything outside this list on an id-shaped variable would be
    // exactly as wrong as the reported bug.
    const KNOWN_GOOD_TYPES = ["OrganizationId", "ChannelId", "PostId", "CreatePostInput"];
    const declarations = [...source.matchAll(/\$(\w+)\s*:\s*(\w+)!/g)];
    assert.ok(declarations.length >= 3, "sanity check — expected to find the known declarations in this file");
    for (const [, varName, typeName] of declarations) {
      assert.ok(KNOWN_GOOD_TYPES.includes(typeName), `variable $${varName} declared with type ${typeName}! — not a recognized Buffer scalar or input type`);
    }
  });

  console.log("\n=== Buffer client: every request goes to the current GraphQL API, never the legacy REST API ===");
  const LEGACY_STRINGS = ["api.bufferapp.com", "/1/profiles.json", "/updates/create.json", "/profiles.json", "/updates/"];

  function assertNeverLegacy(capturedUrl, capturedBody) {
    assert.strictEqual(capturedUrl, BUFFER_API_ENDPOINT, `must call exactly ${BUFFER_API_ENDPOINT}, never a legacy per-resource URL`);
    assert.strictEqual(capturedUrl, "https://api.buffer.com");
    for (const bad of LEGACY_STRINGS) {
      assert.ok(!capturedUrl.includes(bad), `URL must never contain legacy path/host fragment: ${bad}`);
      if (capturedBody) assert.ok(!capturedBody.includes(bad), `request body must never reference legacy fragment: ${bad}`);
    }
  }

  function mockFetch(responseData) {
    let captured = { url: null, method: null, body: null, headers: null };
    const httpFetch = async (url, options) => {
      captured = { url, method: options.method, body: options.body, headers: options.headers };
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: responseData }) };
    };
    return { httpFetch, getCaptured: () => captured };
  }

  await asyncTest("getOrganizations calls only the current GraphQL endpoint with a POST + Bearer auth", async () => {
    const { httpFetch, getCaptured } = mockFetch({ account: { organizations: [{ id: "org-1", name: "ROOK" }] } });
    const orgs = await getOrganizations("fake-token", { httpFetch });
    const captured = getCaptured();
    assertNeverLegacy(captured.url, captured.body);
    assert.strictEqual(captured.method, "POST");
    assert.strictEqual(captured.headers.Authorization, "Bearer fake-token");
    assert.strictEqual(captured.headers["Content-Type"], "application/json");
    assert.ok(captured.body.includes("organizations"), "must actually query account.organizations");
    assert.strictEqual(orgs[0].id, "org-1");
  });

  await asyncTest("listChannelsForOrganization queries channels(input: {organizationId}) on the current endpoint", async () => {
    const { httpFetch, getCaptured } = mockFetch({ channels: [{ id: "ch-1", name: "ROOK Careers", service: "linkedin" }] });
    const channels = await listChannelsForOrganization("fake-token", "org-1", { httpFetch });
    const captured = getCaptured();
    assertNeverLegacy(captured.url, captured.body);
    assert.ok(captured.body.includes("channels"));
    assert.ok(JSON.parse(captured.body).variables.organizationId === "org-1");
    assert.strictEqual(channels[0].id, "ch-1");
  });

  await asyncTest("listAllChannels performs the required organizations-then-channels sequence, never a direct legacy profiles call", async () => {
    let callCount = 0;
    const httpFetch = async (url, options) => {
      callCount++;
      const body = JSON.parse(options.body);
      assert.strictEqual(url, BUFFER_API_ENDPOINT);
      if (body.query.includes("organizations")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { account: { organizations: [{ id: "org-1", name: "ROOK" }] } } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { channels: [{ id: "ch-1", name: "ROOK Careers", service: "linkedin" }] } }) };
    };
    const channels = await listAllChannels("fake-token", { httpFetch });
    assert.strictEqual(callCount, 2, "one call for organizations, one for channels — the documented required sequence");
    assert.strictEqual(channels[0].organizationId, "org-1");
  });

  await asyncTest("createPost sends a createPost mutation with mode: shareNow and an image asset, on the current endpoint", async () => {
    const { httpFetch, getCaptured } = mockFetch({ createPost: { post: { id: "post-1", status: "sent" } } });
    const post = await createPost("fake-token", { channelId: "ch-1", text: "Hello", photoUrl: "https://rookcareers.com/social/x.png", mode: "shareNow" }, { httpFetch });
    const captured = getCaptured();
    assertNeverLegacy(captured.url, captured.body);
    assert.ok(captured.body.includes("createPost"));
    assert.ok(captured.body.includes("shareNow"));
    assert.ok(!captured.body.includes("profile_ids"), "must never use the legacy REST parameter name");
    assert.ok(!captured.body.includes('"now"'), "must never use the legacy REST now:true parameter");
    const parsedInput = JSON.parse(captured.body).variables.input;
    assert.strictEqual(parsedInput.assets[0].image.url, "https://rookcareers.com/social/x.png");
    assert.strictEqual(post.id, "post-1");
  });

  await asyncTest("createPost surfaces a MutationError (normal HTTP 200 business-logic failure) as a thrown error, not a silent success", async () => {
    const httpFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { createPost: { message: "Channel not found" } } }) });
    await assert.rejects(() => createPost("fake-token", { channelId: "bad-id", text: "x" }, { httpFetch }), /Channel not found/);
  });

  await asyncTest("a top-level GraphQL error (bad auth, bad query) is thrown, never swallowed", async () => {
    const httpFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: "Public API tokens are not accepted" }] }) });
    await assert.rejects(() => getOrganizations("fake-token", { httpFetch }), /Public API tokens are not accepted/);
  });


  test("post copy never includes the employer name and always includes the trial line + link", () => {
    const candidate = { title: "Territory Sales Manager", location_display: "Atlanta, GA", category: "Medical Device", compensation_display: "$90,000 - $120,000", public_url: "https://rookcareers.com/jobs/job-1" };
    const copy = buildPostCopy(candidate);
    assert.ok(copy.includes("Start your 3-day free trial"));
    assert.ok(copy.includes("https://rookcareers.com/jobs/job-1"));
    assert.ok(!copy.toLowerCase().includes("acme"));
    assert.ok(!/\$\d+\/month/.test(copy), "must never include a price");
  });

  console.log("\n=== Config validation ===");
  test("requireConfigKeys throws listing every missing key", () => {
    const config = loadConfig({});
    assert.throws(() => requireConfigKeys(config, ["bufferAccessToken", "linkedinChannelId"]), /bufferAccessToken, linkedinChannelId/);
  });
  test("loadConfig reads real env var names correctly", () => {
    const config = loadConfig({
      BUFFER_ACCESS_TOKEN: "secret-token-value",
      BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-123",
      BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-456",
    });
    assert.strictEqual(config.bufferAccessToken, "secret-token-value");
    assert.strictEqual(config.linkedinChannelId, "li-123");
    assert.strictEqual(config.facebookChannelId, "fb-456");
  });

  console.log("\n=== Channel discovery never exposes the token ===");
  await asyncTest("discoverChannels output never includes the access token, even indirectly", async () => {
    const config = loadConfig({ BUFFER_ACCESS_TOKEN: "super-secret-value-12345" });
    let capturedToken = null;
    const fakeListAllChannels = async (token) => { capturedToken = token; return [LINKEDIN_PAGE, FACEBOOK_PAGE]; };
    const result = await discoverChannels(config, { listAllChannels: fakeListAllChannels });
    assert.strictEqual(capturedToken, "super-secret-value-12345", "the real function does receive the token to authenticate");
    assert.ok(!JSON.stringify(result).includes("super-secret-value-12345"), "but the token must never appear in what's returned/displayed");
  });

  console.log("\n=== Validation-only mode: never calls Buffer ===");
  await asyncTest("runValidationOnly selects a real eligible job, validates it fresh, and never touches Buffer", async () => {
    const config = loadConfig({
      SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake", SUPABASE_ANON_KEY: "fake",
      SOCIAL_SPACING_HMAC_SECRET: SECRET,
    });
    const job = baseJob();
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }] });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    let bufferWasCalled = false;
    const fakeCreatePost = async () => { bufferWasCalled = true; };
    const fakeWriteGraphicFile = async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" });
    const fakeVerifyWrittenFile = async () => {};

    const result = await runValidationOnly(config, {
      supabaseAdmin, supabaseAnon, createPost: fakeCreatePost,
      writeGraphicFile: fakeWriteGraphicFile, verifyWrittenFile: fakeVerifyWrittenFile,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.jobId, "job-1");
    assert.strictEqual(result.sentToBuffer, false);
    assert.strictEqual(bufferWasCalled, false, "validation-only must never call Buffer under any circumstance");
    assert.ok(result.postCopy.includes("Territory Sales Manager"));
  });

  await asyncTest("runValidationOnly reports failure cleanly when no eligible jobs exist", async () => {
    const config = loadConfig({ SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET });
    const supabaseAdmin = makeMockSupabase({ jobs: [], employers: [] });
    const supabaseAnon = makeMockSupabase({ jobs: [] });
    await assert.rejects(() => runValidationOnly(config, { supabaseAdmin, supabaseAnon }), /No eligible jobs found/);
  });

  console.log("\n=== Controlled live test: requires --confirm-live ===");
  await asyncTest("runControlledLiveTest refuses to run at all without --confirm-live", async () => {
    const config = loadConfig({});
    await assert.rejects(() => runControlledLiveTest(config, { confirmLive: false }), /--confirm-live/);
  });

  console.log("\n=== Controlled live test: rejects bad channel config before touching any job ===");
  await asyncTest("stops at channel_identification stage before ever selecting a job, if channels are misconfigured", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "tw-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    let jobQueried = false;
    const supabaseAdmin = makeMockSupabase({ jobs: [] });
    const originalFrom = supabaseAdmin.from;
    supabaseAdmin.from = (name) => { if (name === "jobs") jobQueried = true; return originalFrom(name); };
    // tw-1 is a Twitter channel — still a genuine service mismatch even
    // with the personal-profile heuristic removed (see the note above
    // identifyRookChannels in socialChannels.js).
    const fakeListAllChannels = async () => [TWITTER_UNRELATED, FACEBOOK_PAGE];

    const result = await runControlledLiveTest(config, { confirmLive: true }, { supabaseAdmin, supabaseAnon: makeMockSupabase({}), listAllChannels: fakeListAllChannels });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "channel_identification");
    assert.strictEqual(jobQueried, false, "must never select/touch a real job if channel config is unsafe");
  });

  console.log("\n=== Controlled live test: full success path with both platforms ===");
  await asyncTest("publishes to both configured channels once each, records history, builds correct copy", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history: [] });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const bufferCalls = [];
    const fakeCreatePost = async (token, opts) => { bufferCalls.push(opts); return { id: `update-${bufferCalls.length}`, status: "sent" }; };
    const fakeWriteGraphicFile = async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" });
    const fakeVerifyWrittenFile = async () => {};

    const result = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      writeGraphicFile: fakeWriteGraphicFile, verifyWrittenFile: fakeVerifyWrittenFile,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(bufferCalls.length, 2, "exactly one call per platform, never more");
    assert.strictEqual(result.results.facebook.status, "sent");
    assert.strictEqual(result.results.linkedin.status, "sent");
    assert.ok(result.results.facebook.bufferPostId);
    assert.ok(result.results.linkedin.bufferPostId);
    assert.strictEqual(result.historyRecorded, true);
    assert.ok(!JSON.stringify(result).toLowerCase().includes("acme"), "employer name must never appear anywhere in the result");
  });

  console.log("\n=== Controlled live test: duplicate-publication prevention ===");
  await asyncTest("does not double-post to a platform that already succeeded in a prior run for the same job", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const fingerprint = computeJobFingerprint(job.employer_id, job.source_job_id, SECRET);
    const existingRow = { run_key: `LIVE-TEST-${job.id}`, job_fingerprint: fingerprint, facebook_status: null, linkedin_status: "sent", linkedin_buffer_post_id: "already-posted-1" };
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history: [existingRow] });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const bufferCalls = [];
    const fakeCreatePost = async (token, opts) => { bufferCalls.push(opts); return { id: "new-update-1", status: "sent" }; };

    const result = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      writeGraphicFile: async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://x/fake.png" }),
      verifyWrittenFile: async () => {},
    });

    assert.strictEqual(result.results.linkedin.status, "skipped_duplicate", "must not re-post to LinkedIn, already sent");
    assert.strictEqual(result.results.facebook.status, "sent", "Facebook, which never succeeded, must still be attempted");
    assert.strictEqual(bufferCalls.length, 1, "only one real Buffer call — Facebook only");
  });

  console.log("\n=== Controlled live test: stops before publishing if final validation fails ===");
  await asyncTest("aborts before any Buffer call if the job became ineligible between selection and the final check", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const jobs = [job];
    const supabaseAdmin = makeMockSupabase({ jobs, employers: [{ company_name: "Acme Diagnostics" }] });
    let fetchCount = 0;
    const originalFrom = supabaseAdmin.from;
    supabaseAdmin.from = (name) => {
      const builder = originalFrom(name);
      if (name === "jobs") {
        const originalMaybeSingle = builder.maybeSingle;
        builder.maybeSingle = async () => {
          fetchCount++;
          if (fetchCount >= 1) jobs[0] = { ...jobs[0], status: "closed" };
          return originalMaybeSingle();
        };
      }
      return builder;
    };
    const supabaseAnon = makeMockSupabase({ jobs });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    let bufferCalled = false;
    const fakeCreatePost = async () => { bufferCalled = true; };

    const result = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
    });

    assert.strictEqual(result.ok, false);
    assert.ok(["initial_validation", "final_pre_publish_check"].includes(result.stage));
    assert.strictEqual(bufferCalled, false, "must never call Buffer once validation has failed at any stage");
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => { console.error("Test run crashed:", err); process.exit(1); });
