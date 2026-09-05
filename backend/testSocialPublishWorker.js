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
  runScheduledSlot, getSchedulerStatus,
} = require("./socialPublishWorker");
const { computeJobFingerprintForJob } = require("./socialAutomation");
const { preflightCheckMedia } = require("./socialMediaPreflight");
const { uploadGraphicToStorage, buildObjectPath, ensureBucketExists, BUCKET_NAME } = require("./socialMediaStorage");

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
      neq: (col, val) => { filters.push((row) => row[col] !== val); return builder; },
      in: (col, vals) => { filters.push((row) => vals.includes(row[col])); return builder; },
      order: () => builder,
      limit: () => builder,
      not: () => builder,
      maybeSingle: async () => {
        const rows = (name === "jobs" ? jobs : name === "employers" ? employers : history).filter((r) => filters.every((f) => f(r)));
        return { data: rows[0] || null, error: null };
      },
      upsert: async (row, opts = {}) => {
        // Genuinely simulates upsert-on-conflict, matching real
        // Postgres/PostgREST behavior for onConflict: "run_key" — an
        // existing row with the same run_key is updated in place, not
        // duplicated. Without this, a test could "pass" even if the
        // real upsert call were broken and silently created a second
        // row instead of updating the first.
        const conflictCol = opts.onConflict || "run_key";
        const existingIndex = history.findIndex((r) => r[conflictCol] === row[conflictCol]);
        if (existingIndex >= 0) history[existingIndex] = { ...history[existingIndex], ...row };
        else history.push(row);
        return { data: row, error: null };
      },
      then: (resolve) => {
        const rows = (name === "jobs" ? jobs : name === "employers" ? employers : history).filter((r) => filters.every((f) => f(r)));
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  // Minimal mock of the Supabase Storage namespace, matching the
  // exact calls backend/socialMediaStorage.js makes — used whenever a
  // test doesn't explicitly inject its own uploadGraphicToStorage.
  const storageObjects = {};
  const storage = {
    listBuckets: async () => ({ data: [{ name: "social-creatives" }], error: null }),
    createBucket: async () => ({ data: { name: "social-creatives" }, error: null }),
    from: (bucket) => ({
      upload: async (path, buffer, opts) => { storageObjects[`${bucket}/${path}`] = { buffer, contentType: opts?.contentType }; return { data: { path }, error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://fake-project.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
    }),
  };

  return { from: table, storage };
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
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost, preflightCheckMedia: async () => ({ ok: true }),
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

  console.log("\n=== Supabase Storage media hosting: replaces container-local files entirely ===");

  function makeMockStorageClient({ bucketAlreadyExists = true, createBucketError = null, uploadError = null } = {}) {
    const uploadedObjects = {};
    return {
      storage: {
        listBuckets: async () => ({ data: bucketAlreadyExists ? [{ name: BUCKET_NAME }] : [], error: null }),
        createBucket: async (name, opts) => {
          if (createBucketError) return { data: null, error: { message: createBucketError } };
          return { data: { name, ...opts }, error: null };
        },
        from: (bucket) => ({
          upload: async (path, buffer, opts) => {
            if (uploadError) return { data: null, error: { message: uploadError } };
            uploadedObjects[path] = { buffer, opts };
            return { data: { path }, error: null };
          },
          getPublicUrl: (path) => ({ data: { publicUrl: `https://fake-project.supabase.co/storage/v1/object/public/${bucket}/${path}` } }),
        }),
      },
      _uploadedObjects: uploadedObjects,
    };
  }

  test("buildObjectPath never includes an employer name — it isn't even given one to work with", () => {
    const path = buildObjectPath({ dateStr: "2026-09-05", slot: "live-test", jobId: "job-123", contentVersion: "abc123" });
    assert.strictEqual(path, "2026-09-05/live-test-job-123-abc123.png");
  });
  test("buildObjectPath rejects unsafe path segments (traversal attempt)", () => {
    assert.throws(() => buildObjectPath({ dateStr: "2026-09-05", slot: "live-test", jobId: "../../etc/passwd", contentVersion: "abc123" }), /Unsafe job_id/);
  });

  await asyncTest("ensureBucketExists is a no-op when the bucket already exists", async () => {
    const client = makeMockStorageClient({ bucketAlreadyExists: true });
    let createCalled = false;
    client.storage.createBucket = async () => { createCalled = true; return { data: null, error: null }; };
    await ensureBucketExists(client);
    assert.strictEqual(createCalled, false, "must not attempt to create a bucket that's already there");
  });
  await asyncTest("ensureBucketExists creates the bucket, configured public and PNG-only, when missing", async () => {
    const client = makeMockStorageClient({ bucketAlreadyExists: false });
    let capturedOpts = null;
    client.storage.createBucket = async (name, opts) => { capturedOpts = opts; return { data: { name }, error: null }; };
    await ensureBucketExists(client);
    assert.strictEqual(capturedOpts.public, true);
    assert.deepStrictEqual(capturedOpts.allowedMimeTypes, ["image/png"]);
  });
  await asyncTest("ensureBucketExists treats a concurrent 'already exists' creation error as success, not a failure", async () => {
    const client = makeMockStorageClient({ bucketAlreadyExists: false, createBucketError: "Bucket already exists" });
    await assert.doesNotReject(() => ensureBucketExists(client));
  });
  await asyncTest("ensureBucketExists throws a clear error for a genuine creation failure", async () => {
    const client = makeMockStorageClient({ bucketAlreadyExists: false, createBucketError: "Insufficient permissions" });
    await assert.rejects(() => ensureBucketExists(client), /Insufficient permissions/);
  });

  await asyncTest("uploadGraphicToStorage uploads with contentType image/png and returns a real public URL", async () => {
    const client = makeMockStorageClient();
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const result = await uploadGraphicToStorage(client, { dateStr: "2026-09-05", slot: "live-test", jobId: "job-123", contentVersion: "abc123", buffer });
    assert.strictEqual(client._uploadedObjects["2026-09-05/live-test-job-123-abc123.png"].opts.contentType, "image/png");
    assert.strictEqual(result.publicUrl, "https://fake-project.supabase.co/storage/v1/object/public/social-creatives/2026-09-05/live-test-job-123-abc123.png");
    assert.ok(!result.publicUrl.includes("localhost") && !result.publicUrl.includes("127.0.0.1"), "must be a real external URL, not a local address");
  });
  await asyncTest("uploadGraphicToStorage throws a clear error on upload failure, rather than silently continuing", async () => {
    const client = makeMockStorageClient({ uploadError: "Payload too large" });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await assert.rejects(() => uploadGraphicToStorage(client, { dateStr: "2026-09-05", slot: "live-test", jobId: "job-123", contentVersion: "abc123", buffer }), /Payload too large/);
  });
  await asyncTest("uploadGraphicToStorage rejects an empty buffer before ever calling Storage", async () => {
    const client = makeMockStorageClient();
    await assert.rejects(() => uploadGraphicToStorage(client, { dateStr: "2026-09-05", slot: "live-test", jobId: "job-123", contentVersion: "abc123", buffer: Buffer.alloc(0) }), /empty or invalid/);
  });
  await asyncTest("uploadGraphicToStorage's public URL is stable and non-expiring — no signature or expiry parameters", async () => {
    const client = makeMockStorageClient();
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await uploadGraphicToStorage(client, { dateStr: "2026-09-05", slot: "live-test", jobId: "job-123", contentVersion: "abc123", buffer });
    assert.ok(!result.publicUrl.includes("token="), "must use getPublicUrl, never a signed/expiring URL");
    assert.ok(!result.publicUrl.includes("Expires="));
  });
  test("cross-instance-safety: socialMediaStorage.js has no dependency on the local filesystem at all", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("./socialMediaStorage"), "utf8");
    assert.ok(!/require\((["'])fs\1\)/.test(source), "must never require the 'fs' module — hosting must not depend on which replica happens to handle a given request");
  });

  console.log("\n=== The full worker flow uses Storage upload, never local-file write ===");
  test("socialPublishWorker.js no longer references the old local-file storage module at all", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("./socialPublishWorker"), "utf8");
    assert.ok(!source.includes("socialGraphicStorage"), "must not fall back to container-local media hosting");
    assert.ok(source.includes("socialMediaStorage"), "must use the new Storage-based hosting module");
  });

  console.log("\n=== Facebook createPost includes the required metadata; LinkedIn is left unchanged ===");
  await asyncTest("the Facebook createPost call includes metadata: { facebook: { type: 'post' } }", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history: [] });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const calls = [];
    const fakeCreatePost = async (token, opts) => { calls.push(opts); return { id: `update-${calls.length}`, status: "sent" }; };

    await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      preflightCheckMedia: async () => ({ ok: true }),
      writeGraphicFile: async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" }),
      verifyWrittenFile: async () => {},
    });

    const facebookCall = calls.find((c) => c.channelId === "fb-page-1");
    const linkedinCall = calls.find((c) => c.channelId === "li-page-1");
    assert.deepStrictEqual(facebookCall.metadata, { facebook: { type: "post" } }, "Facebook must include the required post-type metadata — this is the exact reported bug fix");
    assert.strictEqual(linkedinCall.metadata, undefined, "LinkedIn must be left unchanged — no metadata added, per direct instruction");
  });

  console.log("\n=== Preflight media check: real request-level verification, not just a local file check ===");
  function mockPreflightFetch(response) {
    return async () => response;
  }
  await asyncTest("preflightCheckMedia passes for a genuinely valid PNG response", async () => {
    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("restofpngdata")]);
    const httpFetch = mockPreflightFetch({ status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength) });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, true);
  });
  await asyncTest("preflightCheckMedia fails when the URL is unreachable (network error)", async () => {
    const httpFetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("Could not reach"));
  });
  await asyncTest("preflightCheckMedia fails on a non-200 status", async () => {
    const httpFetch = mockPreflightFetch({ status: 404, headers: { get: () => null } });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("404"));
  });
  await asyncTest("preflightCheckMedia fails on a redirect instead of a direct 200 (redirect: manual surfaces the 3xx)", async () => {
    const httpFetch = mockPreflightFetch({ status: 302, headers: { get: () => null } });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("redirected"));
  });
  await asyncTest("preflightCheckMedia fails on the wrong Content-Type — this is exactly the 'Image could not be read' failure mode", async () => {
    const httpFetch = mockPreflightFetch({ status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("<html>404</html>").buffer });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("text/html"));
  });
  await asyncTest("preflightCheckMedia fails on an empty body", async () => {
    const httpFetch = mockPreflightFetch({ status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => new ArrayBuffer(0) });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("empty"));
  });
  await asyncTest("preflightCheckMedia fails on invalid PNG signature bytes (correct content-type, corrupt/wrong body)", async () => {
    const httpFetch = mockPreflightFetch({ status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => Buffer.from("not a real png file").buffer });
    const result = await preflightCheckMedia("https://rookcareers.com/social/featured/x.png", { httpFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason.includes("signature"));
  });

  console.log("\n=== The preflight gate blocks BOTH channels entirely on failure, and records a retry-safe history row ===");
  await asyncTest("if preflight fails, no Buffer call is made to either platform, and a failure row is recorded", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const history = [];
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    let bufferCalled = false;
    const fakeCreatePost = async () => { bufferCalled = true; };

    const result = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      preflightCheckMedia: async () => ({ ok: false, reason: "Media URL returned Content-Type \"text/html\", expected image/png" }),
      writeGraphicFile: async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" }),
      verifyWrittenFile: async () => {},
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "media_preflight");
    assert.strictEqual(bufferCalled, false, "must never call Buffer for either channel if preflight fails");
    assert.strictEqual(history.length, 1, "a failure row must still be recorded");
    assert.strictEqual(history[0].facebook_status, "failed");
    assert.strictEqual(history[0].linkedin_status, "failed");
    assert.ok(history[0].failure_reason.includes("Media preflight failed"));
  });

  console.log("\n=== Retrying a failed run after correction is safe — the unique run_key updates the existing row instead of blocking ===");
  await asyncTest("a job that failed on both platforms can be retried, successfully publishing on the second attempt, updating (not duplicating) the history row", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const history = [];
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];

    // First attempt: preflight fails (the exact reported scenario) —
    // nothing published, one failure row recorded.
    const firstAttempt = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels,
      createPost: async () => { throw new Error("should never be called on first attempt"); },
      preflightCheckMedia: async () => ({ ok: false, reason: "Image could not be read from its URL" }),
      writeGraphicFile: async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" }),
      verifyWrittenFile: async () => {},
    });
    assert.strictEqual(firstAttempt.ok, false);
    assert.strictEqual(history.length, 1, "exactly one row after the first failed attempt");

    // Second attempt (simulating a retry after fixing the underlying
    // media issue): preflight now passes, both platforms succeed.
    const calls = [];
    const secondAttempt = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels,
      createPost: async (token, opts) => { calls.push(opts); return { id: `update-${calls.length}`, status: "sent" }; },
      preflightCheckMedia: async () => ({ ok: true }),
      writeGraphicFile: async () => ({ absolutePath: "/tmp/fake.png", publicUrl: "https://rookcareers.com/social/featured/fake.png" }),
      verifyWrittenFile: async () => {},
    });

    assert.strictEqual(secondAttempt.ok, true, "the retry must succeed once the underlying media problem is fixed — the run_key must not permanently block it");
    assert.strictEqual(calls.length, 2, "both platforms attempted on retry, since neither succeeded on the failed first attempt");
    assert.strictEqual(history.length, 1, "the SAME row must be updated in place, never duplicated, even across a failed-then-successful retry");
    assert.strictEqual(history[0].facebook_status, "sent");
    assert.strictEqual(history[0].linkedin_status, "sent");
  });

  console.log("\n=== Controlled live test: duplicate-publication prevention ===");
  await asyncTest("does not double-post to a platform that already succeeded in a prior run for the same job", async () => {
    const config = loadConfig({
      SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const fingerprint = computeJobFingerprintForJob(job, SECRET);
    const existingRow = { run_key: `LIVE-TEST-${job.id}`, job_fingerprint: fingerprint, facebook_status: null, linkedin_status: "sent", linkedin_buffer_post_id: "already-posted-1" };
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history: [existingRow] });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const bufferCalls = [];
    const fakeCreatePost = async (token, opts) => { bufferCalls.push(opts); return { id: "new-update-1", status: "sent" }; };

    const result = await runControlledLiveTest(config, { confirmLive: true }, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost, preflightCheckMedia: async () => ({ ok: true }),
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
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost, preflightCheckMedia: async () => ({ ok: true }),
    });

    assert.strictEqual(result.ok, false);
    assert.ok(["initial_validation", "final_pre_publish_check"].includes(result.stage));
    assert.strictEqual(bufferCalled, false, "must never call Buffer once validation has failed at any stage");
  });

  console.log("\n=== Recurring automation: disabled state sends nothing ===");
  await asyncTest("SOCIAL_AUTOMATION_ENABLED unset (missing) results in a no-op — no candidate selection, no Buffer call, no history write", async () => {
    const config = loadConfig({ BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1" });
    let jobQueried = false;
    const supabaseAdmin = makeMockSupabase({});
    const originalFrom = supabaseAdmin.from;
    supabaseAdmin.from = (name) => { if (name === "jobs") jobQueried = true; return originalFrom(name); };
    const result = await runScheduledSlot("am", "2026-09-05", config, { supabaseAdmin });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "disabled");
    assert.strictEqual(jobQueried, false, "must never touch job data when disabled");
  });
  await asyncTest("SOCIAL_AUTOMATION_ENABLED='false' explicitly also results in a no-op", async () => {
    const config = loadConfig({ SOCIAL_AUTOMATION_ENABLED: "false", BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1" });
    const result = await runScheduledSlot("am", "2026-09-05", config, { supabaseAdmin: makeMockSupabase({}) });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "disabled");
  });

  console.log("\n=== Recurring automation: duplicate scheduler triggers are idempotent ===");
  await asyncTest("a second dispatch for the same run_key (simulating a duplicate trigger or restart) does not re-post — treated as already completed", async () => {
    const config = loadConfig({
      SOCIAL_AUTOMATION_ENABLED: "true", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const history = [];
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    let bufferCallCount = 0;
    const fakeCreatePost = async () => { bufferCallCount++; return { id: `update-${bufferCallCount}`, status: "scheduled" }; };
    const deps = {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      preflightCheckMedia: async () => ({ ok: true }),
      uploadGraphicToStorage: async () => ({ publicUrl: "https://x/fake.png" }),
    };

    const first = await runScheduledSlot("am", "2026-09-05", config, deps);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(bufferCallCount, 2, "first dispatch posts to both platforms");

    const second = await runScheduledSlot("am", "2026-09-05", config, deps);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.stage, "already_completed");
    assert.strictEqual(bufferCallCount, 2, "the duplicate trigger must not call Buffer again at all");
    assert.strictEqual(history.length, 1, "must never create a second history row for the same run_key");
  });

  console.log("\n=== Recurring automation: AM/PM separation — the PM job must differ from the morning's job ===");
  await asyncTest("the PM run excludes the exact job the AM run selected that same day", async () => {
    const config = loadConfig({
      SOCIAL_AUTOMATION_ENABLED: "true", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const jobA = baseJob({ id: "job-a", employer_id: "employer-A", source_job_id: "src-a", title_original: "Territory Sales Manager A" });
    const jobB = baseJob({ id: "job-b", employer_id: "employer-B", source_job_id: "src-b", title_original: "Territory Sales Manager B" });
    const history = [];
    const supabaseAdmin = makeMockSupabase({ jobs: [jobA, jobB], employers: [{ company_name: "Acme Diagnostics" }], history });
    const supabaseAnon = makeMockSupabase({ jobs: [jobA, jobB] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const fakeCreatePost = async () => ({ id: "update-1", status: "scheduled" });
    const deps = {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      preflightCheckMedia: async () => ({ ok: true }),
      uploadGraphicToStorage: async () => ({ publicUrl: "https://x/fake.png" }),
    };

    const amResult = await runScheduledSlot("am", "2026-09-05", config, deps);
    assert.strictEqual(amResult.ok, true);
    const amJobId = amResult.jobId;

    const pmResult = await runScheduledSlot("pm", "2026-09-05", config, deps);
    assert.strictEqual(pmResult.ok, true);
    assert.notStrictEqual(pmResult.jobId, amJobId, "the PM job must be different from the AM job");
  });

  console.log("\n=== Recurring automation: candidate fallback on final-validation failure ===");
  await asyncTest("if the top-ranked candidate fails final validation, the next eligible candidate is used automatically", async () => {
    const config = loadConfig({
      SOCIAL_AUTOMATION_ENABLED: "true", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    // jobBad looks eligible at selection time (fresher, so ranks
    // first) but is closed by the time it's re-fetched for final
    // validation — simulating a real race between selection and
    // final-check. jobGood is a genuinely valid fallback.
    const jobBad = baseJob({ id: "job-bad", employer_id: "employer-A", source_job_id: "src-bad", last_seen_at: NOW.toISOString() });
    const jobGood = baseJob({ id: "job-good", employer_id: "employer-B", source_job_id: "src-good", last_seen_at: new Date(NOW.getTime() - 60 * 1000).toISOString() });
    const jobs = [jobBad, jobGood];
    const supabaseAdmin = makeMockSupabase({ jobs, employers: [{ company_name: "Acme Diagnostics" }], history: [] });
    let jobBadFetchCount = 0;
    const originalFrom = supabaseAdmin.from;
    supabaseAdmin.from = (name) => {
      const builder = originalFrom(name);
      if (name === "jobs") {
        const originalMaybeSingle = builder.maybeSingle;
        builder.maybeSingle = async () => {
          const result = await originalMaybeSingle();
          if (result.data && result.data.id === "job-bad") {
            jobBadFetchCount++;
            return { data: { ...result.data, status: "closed" }, error: null }; // always closed on fresh re-fetch
          }
          return result;
        };
      }
      return builder;
    };
    const supabaseAnon = makeMockSupabase({ jobs });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    const fakeCreatePost = async () => ({ id: "update-1", status: "scheduled" });

    const result = await runScheduledSlot("am", "2026-09-05", config, {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: fakeCreatePost,
      preflightCheckMedia: async () => ({ ok: true }),
      uploadGraphicToStorage: async () => ({ publicUrl: "https://x/fake.png" }),
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.jobId, "job-good", "must fall through to the next eligible candidate");
    assert.strictEqual(result.skippedCandidates.length, 1);
    assert.strictEqual(result.skippedCandidates[0].jobId, "job-bad");
    assert.ok(jobBadFetchCount >= 1, "sanity check — the bad candidate was actually re-validated, not just skipped blindly");
  });
  await asyncTest("if every candidate fails final validation, the run reports no_valid_candidate rather than posting anything", async () => {
    const config = loadConfig({
      SOCIAL_AUTOMATION_ENABLED: "true", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob({ id: "job-only" });
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history: [] });
    const originalFrom = supabaseAdmin.from;
    supabaseAdmin.from = (name) => {
      const builder = originalFrom(name);
      if (name === "jobs") {
        const originalMaybeSingle = builder.maybeSingle;
        builder.maybeSingle = async () => {
          const result = await originalMaybeSingle();
          return result.data ? { data: { ...result.data, status: "closed" }, error: null } : result;
        };
      }
      return builder;
    };
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    let bufferCalled = false;
    const result = await runScheduledSlot("am", "2026-09-05", config, {
      supabaseAdmin, supabaseAnon, listAllChannels: async () => [LINKEDIN_PAGE, FACEBOOK_PAGE],
      createPost: async () => { bufferCalled = true; },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, "no_valid_candidate");
    assert.strictEqual(bufferCalled, false);
  });

  console.log("\n=== Recurring automation: partial-platform retry ===");
  await asyncTest("if Facebook failed but LinkedIn succeeded, a re-dispatch of the same run_key retries only Facebook", async () => {
    const config = loadConfig({
      SOCIAL_AUTOMATION_ENABLED: "true", SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_ANON_KEY: "x", SOCIAL_SPACING_HMAC_SECRET: SECRET,
      BUFFER_ACCESS_TOKEN: "x", BUFFER_ROOK_LINKEDIN_CHANNEL_ID: "li-page-1", BUFFER_ROOK_FACEBOOK_CHANNEL_ID: "fb-page-1",
    });
    const job = baseJob();
    const history = [];
    const supabaseAdmin = makeMockSupabase({ jobs: [job], employers: [{ company_name: "Acme Diagnostics" }], history });
    const supabaseAnon = makeMockSupabase({ jobs: [job] });
    const fakeListAllChannels = async () => [LINKEDIN_PAGE, FACEBOOK_PAGE];
    let facebookAttempts = 0, linkedinAttempts = 0;
    const flakyCreatePost = async (token, opts) => {
      if (opts.channelId === "fb-page-1") { facebookAttempts++; throw new Error("Facebook temporarily unavailable"); }
      linkedinAttempts++;
      return { id: "li-update-1", status: "scheduled" };
    };
    const deps = {
      supabaseAdmin, supabaseAnon, listAllChannels: fakeListAllChannels, createPost: flakyCreatePost,
      preflightCheckMedia: async () => ({ ok: true }),
      uploadGraphicToStorage: async () => ({ publicUrl: "https://x/fake.png" }),
    };

    const first = await runScheduledSlot("am", "2026-09-05", config, deps);
    assert.strictEqual(first.ok, false, "overall run is not fully successful while one platform failed");
    assert.strictEqual(first.results.facebook.status, "failed");
    assert.strictEqual(first.results.linkedin.status, "scheduled");
    assert.strictEqual(facebookAttempts, 1);
    assert.strictEqual(linkedinAttempts, 1);

    // Retry: Facebook now succeeds.
    const reliableCreatePost = async (token, opts) => {
      if (opts.channelId === "fb-page-1") { facebookAttempts++; return { id: "fb-update-1", status: "scheduled" }; }
      linkedinAttempts++;
      return { id: "li-update-2", status: "scheduled" };
    };
    const second = await runScheduledSlot("am", "2026-09-05", config, { ...deps, createPost: reliableCreatePost });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.results.facebook.status, "scheduled");
    assert.strictEqual(facebookAttempts, 2, "Facebook retried exactly once more");
    assert.strictEqual(linkedinAttempts, 1, "LinkedIn must NOT be re-posted — it already succeeded");
    assert.strictEqual(history.length, 1, "still one row, updated in place");
  });

  console.log("\n=== Recurring automation: scheduler status reporting ===");
  await asyncTest("getSchedulerStatus reports enabled/disabled, timezone, next runs, and last-run results without any secret", async () => {
    const config = loadConfig({ SOCIAL_AUTOMATION_ENABLED: "true", BUFFER_ACCESS_TOKEN: "super-secret-value" });
    const history = [
      { run_key: "2026-09-04-am", slot: "am", facebook_status: "scheduled", linkedin_status: "scheduled", scheduled_for: "2026-09-04T13:00:00Z", failure_reason: null },
      { run_key: "2026-09-04-pm", slot: "pm", facebook_status: "failed", linkedin_status: "scheduled", scheduled_for: "2026-09-04T21:00:00Z", failure_reason: "Facebook error" },
    ];
    const supabaseAdmin = makeMockSupabase({ history });
    const status = await getSchedulerStatus(config, { supabaseAdmin });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.timezone, "America/New_York");
    assert.ok(status.nextAmRun && status.nextPmRun);
    assert.strictEqual(status.lastAmRun.runKey, "2026-09-04-am");
    assert.strictEqual(status.lastPmRun.facebookStatus, "failed");
    assert.ok(!JSON.stringify(status).includes("super-secret-value"), "must never include the access token or any secret");
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => { console.error("Test run crashed:", err); process.exit(1); });
