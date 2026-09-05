#!/usr/bin/env node
// Buffer publishing worker — channel discovery, validation-only dry
// runs, and a controlled single-post live test. The recurring
// twice-daily scheduler is intentionally NOT part of this file; this
// only ever publishes when explicitly invoked with --confirm-live.
//
// Usage (from the DigitalOcean console, or locally with real env vars):
//   node backend/socialPublishWorker.js discover
//   node backend/socialPublishWorker.js validate
//   node backend/socialPublishWorker.js live-test --confirm-live
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY, SOCIAL_SPACING_HMAC_SECRET, BUFFER_ACCESS_TOKEN,
// BUFFER_ROOK_LINKEDIN_CHANNEL_ID, BUFFER_ROOK_FACEBOOK_CHANNEL_ID.
// See .env.example. Never logs BUFFER_ACCESS_TOKEN or any other secret.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const {
  evaluateEligibility,
  scoreAndSortCandidates,
  buildCandidateResponse,
  computeJobFingerprint,
  computeEmployerSpacingKey,
  buildBrandedTermList,
  buildHistoryRow,
  computeRunKey,
} = require("./socialAutomation");
const { listAllChannels, createPost } = require("./socialBuffer");
const { identifyRookChannels } = require("./socialChannels");
const { buildPostCopy } = require("./socialPostCopy");
const { renderFeaturedJobGraphic } = require("./socialGraphic");
const { writeGraphicFile, verifyWrittenFile } = require("./socialGraphicStorage");

const JOB_COLUMNS = "id, employer_id, source_job_id, title_original, location_raw, territory, ai_analysis, compensation_text, salary_min, salary_max, employment_type, remote_status, experience_min_years, company_name, status, moderation_status, social_eligible, expires_at, last_seen_at";

function loadConfig(env = process.env) {
  return {
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    spacingSecret: env.SOCIAL_SPACING_HMAC_SECRET,
    bufferAccessToken: env.BUFFER_ACCESS_TOKEN,
    linkedinChannelId: env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,
    facebookChannelId: env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID,
    brandedTerms: (env.SOCIAL_BRANDED_TERMS || "").split(",").map((s) => s.trim()).filter(Boolean),
    freshnessWindowDays: Number(env.SOCIAL_FRESHNESS_WINDOW_DAYS) || 3,
    publicAppUrl: env.PUBLIC_APP_URL || "https://rookcareers.com",
  };
}

function requireConfigKeys(config, keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}

async function fetchBrandedTerms(supabaseAdmin, config) {
  const { data, error } = await supabaseAdmin.from("employers").select("company_name");
  if (error) return buildBrandedTermList([], config.brandedTerms);
  return buildBrandedTermList((data || []).map((e) => e.company_name), config.brandedTerms);
}

async function selectTopCandidate(supabaseAdmin, config) {
  const brandedTerms = await fetchBrandedTerms(supabaseAdmin, config);

  const { data: rawJobs, error } = await supabaseAdmin
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("status", "active")
    .eq("moderation_status", "approved")
    .eq("social_eligible", true)
    .order("last_seen_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(`Could not query candidate jobs: ${error.message}`);

  const eligibleJobs = (rawJobs || []).filter(
    (job) => evaluateEligibility(job, { freshnessWindowDays: config.freshnessWindowDays, brandedTerms }).eligible
  );
  if (eligibleJobs.length === 0) {
    throw new Error("No eligible jobs found — nothing available to select for this run");
  }

  const { data: fbHistory } = await supabaseAdmin
    .from("social_post_history").select("job_fingerprint, employer_spacing_key, category, scheduled_for")
    .in("facebook_status", ["scheduled", "sent"]).limit(5000);
  const { data: liHistory } = await supabaseAdmin
    .from("social_post_history").select("job_fingerprint, employer_spacing_key, category, scheduled_for")
    .in("linkedin_status", ["scheduled", "sent"]).limit(5000);
  const allHistory = [...(fbHistory || []), ...(liHistory || [])];

  const previouslyFeaturedJobIds = new Set(
    eligibleJobs
      .filter((job) => allHistory.some((r) => r.job_fingerprint === computeJobFingerprint(job.employer_id, job.source_job_id, config.spacingSecret)))
      .map((job) => job.id)
  );
  const recentEmployerSpacingKeys = new Set(allHistory.map((r) => r.employer_spacing_key).filter(Boolean));
  const recentCategories = allHistory
    .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for))
    .slice(0, 4).map((r) => r.category).filter(Boolean);

  const ranked = scoreAndSortCandidates(eligibleJobs, {
    previouslyFeaturedJobIds, recentEmployerSpacingKeys, recentCategories, spacingSecret: config.spacingSecret,
  });

  return { topJob: ranked[0], brandedTerms };
}

async function provePublicUrlValid(supabaseAnon, jobId) {
  const { data } = await supabaseAnon.from("jobs").select("id").eq("id", jobId).eq("status", "active").maybeSingle();
  return Boolean(data);
}

async function fetchFreshJob(supabaseAdmin, jobId) {
  const { data, error } = await supabaseAdmin.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (error) throw new Error(`Could not re-fetch job ${jobId}: ${error.message}`);
  return data;
}

async function validateJobFresh(supabaseAdmin, supabaseAnon, jobId, config, expectedContentVersion) {
  const job = await fetchFreshJob(supabaseAdmin, jobId);
  if (!job) return { eligible: false, reason_codes: ["not_found"], job: null };

  const brandedTerms = await fetchBrandedTerms(supabaseAdmin, config);
  const result = evaluateEligibility(job, {
    freshnessWindowDays: config.freshnessWindowDays,
    expectedContentVersion,
    brandedTerms,
  });
  const provenPublicUrlValid = await provePublicUrlValid(supabaseAnon, job.id);
  if (!provenPublicUrlValid && !result.reason_codes.includes("invalid_public_url")) {
    result.reason_codes.push("invalid_public_url");
  }
  result.public_url_valid = provenPublicUrlValid;
  result.eligible = result.eligible && provenPublicUrlValid;
  return { ...result, job };
}

async function discoverChannels(config, deps = {}) {
  const listAllChannelsFn = deps.listAllChannels || listAllChannels;
  requireConfigKeys(config, ["bufferAccessToken"]);
  const channels = await listAllChannelsFn(config.bufferAccessToken);
  return channels.map((c) => ({
    id: c.id,
    service: c.service || null,
    displayName: c.name || "(unknown)",
    organizationId: c.organizationId || null,
  }));
}

async function runValidationOnly(config, deps = {}) {
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);
  requireConfigKeys(config, ["supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret"]);

  const { topJob } = await selectTopCandidate(supabaseAdmin, config);
  const candidate = buildCandidateResponse(topJob, config.spacingSecret);
  const validation = await validateJobFresh(supabaseAdmin, supabaseAnon, topJob.id, config, candidate.content_version);

  if (!validation.eligible) {
    return { ok: false, jobId: topJob.id, reasonCodes: validation.reason_codes, candidate };
  }

  const graphicBuffer = await renderFeaturedJobGraphic(candidate);
  const dateStr = new Date().toISOString().slice(0, 10);
  const written = await (deps.writeGraphicFile || writeGraphicFile)({
    dateStr, slot: "validate", jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });
  await (deps.verifyWrittenFile || verifyWrittenFile)(written.absolutePath);

  const postCopy = buildPostCopy(candidate);

  return {
    ok: true,
    jobId: topJob.id,
    candidate,
    validation,
    graphicUrl: written.publicUrl,
    postCopy,
    sentToBuffer: false,
  };
}

async function runControlledLiveTest(config, { confirmLive } = {}, deps = {}) {
  if (!confirmLive) {
    throw new Error("Refusing to publish live — the --confirm-live flag was not provided");
  }

  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);
  const listAllChannelsFn = deps.listAllChannels || listAllChannels;
  const createPostFn = deps.createPost || createPost;

  requireConfigKeys(config, [
    "supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret",
    "bufferAccessToken", "linkedinChannelId", "facebookChannelId",
  ]);

  const availableChannels = await listAllChannelsFn(config.bufferAccessToken);
  const channels = identifyRookChannels(availableChannels, {
    linkedinChannelId: config.linkedinChannelId,
    facebookChannelId: config.facebookChannelId,
  });
  if (!channels.ok) {
    return { ok: false, stage: "channel_identification", errors: channels.errors };
  }

  const { topJob } = await selectTopCandidate(supabaseAdmin, config);
  const candidate = buildCandidateResponse(topJob, config.spacingSecret);

  let validation = await validateJobFresh(supabaseAdmin, supabaseAnon, topJob.id, config, candidate.content_version);
  if (!validation.eligible) {
    return { ok: false, stage: "initial_validation", jobId: topJob.id, reasonCodes: validation.reason_codes };
  }

  // Direct instruction: a final active-status check immediately
  // before publishing — a fresh, second, independent re-check.
  validation = await validateJobFresh(supabaseAdmin, supabaseAnon, topJob.id, config, candidate.content_version);
  if (!validation.eligible) {
    return { ok: false, stage: "final_pre_publish_check", jobId: topJob.id, reasonCodes: validation.reason_codes };
  }

  const fingerprint = computeJobFingerprint(topJob.employer_id, topJob.source_job_id, config.spacingSecret);
  const { data: existingHistory } = await supabaseAdmin
    .from("social_post_history")
    .select("facebook_status, linkedin_status, facebook_buffer_post_id, linkedin_buffer_post_id")
    .eq("job_fingerprint", fingerprint)
    .in("run_key", [computeRunKey(new Date().toISOString().slice(0, 10), "am"), `LIVE-TEST-${topJob.id}`]);
  const alreadyPosted = {
    facebook: (existingHistory || []).some((r) => r.facebook_status === "sent" || r.facebook_status === "scheduled"),
    linkedin: (existingHistory || []).some((r) => r.linkedin_status === "sent" || r.linkedin_status === "scheduled"),
  };

  const graphicBuffer = await renderFeaturedJobGraphic(candidate);
  const dateStr = new Date().toISOString().slice(0, 10);
  const written = await (deps.writeGraphicFile || writeGraphicFile)({
    dateStr, slot: "live-test", jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });
  await (deps.verifyWrittenFile || verifyWrittenFile)(written.absolutePath);

  const postCopy = buildPostCopy(candidate);
  const results = { facebook: null, linkedin: null };

  if (!alreadyPosted.facebook) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.facebook.id, text: postCopy, photoUrl: written.publicUrl, mode: "shareNow",
      });
      results.facebook = { status: "sent", bufferPostId: post?.id || null, channelId: channels.facebook.id };
    } catch (err) {
      results.facebook = { status: "failed", error: err.message, channelId: channels.facebook.id };
    }
  } else {
    results.facebook = { status: "skipped_duplicate", channelId: channels.facebook.id };
  }

  if (!alreadyPosted.linkedin) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.linkedin.id, text: postCopy, photoUrl: written.publicUrl, mode: "shareNow",
      });
      results.linkedin = { status: "sent", bufferPostId: post?.id || null, channelId: channels.linkedin.id };
    } catch (err) {
      results.linkedin = { status: "failed", error: err.message, channelId: channels.linkedin.id };
    }
  } else {
    results.linkedin = { status: "skipped_duplicate", channelId: channels.linkedin.id };
  }

  const historyRow = buildHistoryRow({
    runKey: `LIVE-TEST-${topJob.id}`,
    slot: "am",
    jobId: topJob.id,
    jobFingerprint: fingerprint,
    contentVersion: candidate.content_version,
    employerSpacingKey: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
    category: candidate.category,
    scheduledFor: new Date().toISOString(),
    facebook: { channelId: channels.facebook.id, bufferPostId: results.facebook.bufferPostId || null, status: results.facebook.status === "sent" ? "sent" : results.facebook.status },
    linkedin: { channelId: channels.linkedin.id, bufferPostId: results.linkedin.bufferPostId || null, status: results.linkedin.status === "sent" ? "sent" : results.linkedin.status },
    creativeUrl: written.publicUrl,
    captionVersion: "v1",
    selectedAt: new Date().toISOString(),
    validatedAt: new Date().toISOString(),
    failureReason: [results.facebook.error, results.linkedin.error].filter(Boolean).join(" | ") || null,
  });

  const { error: historyError } = await supabaseAdmin.from("social_post_history").upsert(historyRow, { onConflict: "run_key" });

  return {
    ok: true,
    jobId: topJob.id,
    candidate,
    channels: { linkedin: channels.linkedin, facebook: channels.facebook },
    postCopy,
    graphicUrl: written.publicUrl,
    results,
    historyRecorded: !historyError,
    historyError: historyError?.message || null,
  };
}

module.exports = {
  loadConfig,
  requireConfigKeys,
  selectTopCandidate,
  validateJobFresh,
  provePublicUrlValid,
  discoverChannels,
  runValidationOnly,
  runControlledLiveTest,
};

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    const [, , command, ...rest] = process.argv;
    const confirmLive = rest.includes("--confirm-live");

    try {
      if (command === "discover") {
        const channels = await discoverChannels(config);
        console.log("\nConnected Buffer channels:\n");
        channels.forEach((c) => console.log(`  ${(c.service || "").padEnd(10)} ${String(c.id).padEnd(28)} ${c.displayName}`));
        console.log("");
      } else if (command === "validate") {
        const result = await runValidationOnly(config);
        console.log(JSON.stringify(result, null, 2));
      } else if (command === "live-test") {
        const result = await runControlledLiveTest(config, { confirmLive });
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Usage: node backend/socialPublishWorker.js <discover|validate|live-test> [--confirm-live]");
        process.exit(1);
      }
    } catch (err) {
      console.error(`\nFAILED: ${err.message}\n`);
      process.exit(1);
    }
  })();
}
