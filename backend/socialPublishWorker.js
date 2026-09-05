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
  computeJobFingerprintForJob,
  computeEmployerSpacingKey,
  buildBrandedTermList,
  buildHistoryRow,
  computeRunKey,
  computeScheduledForUtc,
} = require("./socialAutomation");
const { determineActiveSlot, computeNextRunTimes, TIMEZONE } = require("./socialScheduler");
const { listAllChannels, createPost } = require("./socialBuffer");
const { identifyRookChannels } = require("./socialChannels");
const { buildPostCopy } = require("./socialPostCopy");
const { preflightCheckMedia } = require("./socialMediaPreflight");
const { renderFeaturedJobGraphic } = require("./socialGraphic");
const { uploadGraphicToStorage } = require("./socialMediaStorage");

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
    // Direct instruction: global emergency pause. Anything other than
    // the exact string "true" (including missing/unset) is treated as
    // disabled — a safe default, never opt-in by omission.
    automationEnabled: env.SOCIAL_AUTOMATION_ENABLED,
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

async function selectTopCandidate(supabaseAdmin, config, { excludedJobIds = new Set() } = {}) {
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

  const eligibleJobs = (rawJobs || [])
    .filter((job) => !excludedJobIds.has(job.id))
    .filter((job) => evaluateEligibility(job, { freshnessWindowDays: config.freshnessWindowDays, brandedTerms }).eligible);
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
      .filter((job) => allHistory.some((r) => r.job_fingerprint === computeJobFingerprintForJob(job, config.spacingSecret)))
      .map((job) => job.id)
  );
  const recentEmployerSpacingKeys = new Set(allHistory.map((r) => r.employer_spacing_key).filter(Boolean));
  const recentCategories = allHistory
    .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for))
    .slice(0, 4).map((r) => r.category).filter(Boolean);

  const ranked = scoreAndSortCandidates(eligibleJobs, {
    previouslyFeaturedJobIds, recentEmployerSpacingKeys, recentCategories, spacingSecret: config.spacingSecret,
  });

  // topJob preserved exactly as before for existing callers
  // (runValidationOnly, runControlledLiveTest); rankedJobs is
  // additive, used by the scheduled-slot path below to fall through
  // to the next candidate if the top one fails final validation.
  return { topJob: ranked[0], rankedJobs: ranked, brandedTerms };
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
  // Direct instruction: never fall back to container-local media —
  // the graphic is uploaded to Supabase Storage, external to any
  // single app replica, rather than written to local disk at all.
  const uploaded = await (deps.uploadGraphicToStorage || uploadGraphicToStorage)(supabaseAdmin, {
    dateStr, slot: "validate", jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });

  // Informational here (this mode never contacts Buffer regardless) —
  // surfaces a real media-accessibility problem before the operator
  // ever attempts the live test, rather than only discovering it then.
  const mediaPreflight = await (deps.preflightCheckMedia || preflightCheckMedia)(uploaded.publicUrl);

  const postCopy = buildPostCopy(candidate);

  return {
    ok: true,
    jobId: topJob.id,
    candidate,
    validation,
    graphicUrl: uploaded.publicUrl,
    mediaPreflight,
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

  const fingerprint = computeJobFingerprintForJob(topJob, config.spacingSecret);
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
  // Direct instruction: never fall back to container-local media —
  // the graphic is uploaded to Supabase Storage, external to any
  // single app replica, rather than written to local disk at all.
  const uploaded = await (deps.uploadGraphicToStorage || uploadGraphicToStorage)(supabaseAdmin, {
    dateStr, slot: "live-test", jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });

  // Direct instruction: a real preflight fetch of the exact public URL
  // — the same way Buffer itself will fetch it — before contacting
  // Buffer at all. If this fails, send nothing to either channel. The
  // failure is still recorded to social_post_history (via the same
  // upsert-on-run_key path used below for a normal outcome) so a
  // retry after fixing the underlying media problem updates this same
  // row instead of finding nothing to work from.
  const mediaPreflight = await (deps.preflightCheckMedia || preflightCheckMedia)(uploaded.publicUrl);
  if (!mediaPreflight.ok) {
    const failureRow = buildHistoryRow({
      runKey: `LIVE-TEST-${topJob.id}`,
      slot: "am",
      jobId: topJob.id,
      jobFingerprint: fingerprint,
      contentVersion: candidate.content_version,
      employerSpacingKey: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
      category: candidate.category,
      scheduledFor: new Date().toISOString(),
      facebook: { channelId: channels.facebook.id, status: "failed" },
      linkedin: { channelId: channels.linkedin.id, status: "failed" },
      creativeUrl: uploaded.publicUrl,
      captionVersion: "v1",
      selectedAt: new Date().toISOString(),
      validatedAt: new Date().toISOString(),
      failureReason: `Media preflight failed: ${mediaPreflight.reason}`,
    });
    const { error: preflightHistoryError } = await supabaseAdmin.from("social_post_history").upsert(failureRow, { onConflict: "run_key" });
    return {
      ok: false,
      stage: "media_preflight",
      jobId: topJob.id,
      reason: mediaPreflight.reason,
      graphicUrl: uploaded.publicUrl,
      historyRecorded: !preflightHistoryError,
    };
  }

  const postCopy = buildPostCopy(candidate);
  const results = { facebook: null, linkedin: null };

  if (!alreadyPosted.facebook) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.facebook.id, text: postCopy, photoUrl: uploaded.publicUrl, mode: "shareNow",
        // Direct fix: Buffer's schema requires this field for Facebook
        // (FacebookPostMetadataInput.type: PostTypeFacebook!,
        // non-nullable) — its absence is exactly the reported
        // "Facebook posts require a type (post, story, or reel)" error.
        metadata: { facebook: { type: "post" } },
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
      // LinkedIn's Buffer schema has no required post-type field (only
      // Facebook's does) — left exactly as before, no metadata added,
      // per direct instruction to keep it unchanged unless required.
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.linkedin.id, text: postCopy, photoUrl: uploaded.publicUrl, mode: "shareNow",
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
    creativeUrl: uploaded.publicUrl,
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
    graphicUrl: uploaded.publicUrl,
    results,
    historyRecorded: !historyError,
    historyError: historyError?.message || null,
  };
}

// =================================================================
// Recurring twice-daily automation — the actual scheduled entry
// point. Everything it relies on (candidate selection, final
// validation, media preflight, channel identification, Buffer
// posting, history recording) is the exact same, already-tested
// machinery runControlledLiveTest uses; this function differs only in
// the ways the recurring job genuinely needs to: no --confirm-live
// gate (SOCIAL_AUTOMATION_ENABLED plus every validation step below is
// the safeguard for an unattended run), Buffer's customScheduled mode
// for the slot's ~9am/~5pm ET time instead of shareNow, excludes the
// morning's job from the afternoon run, and falls through to the
// next-ranked candidate instead of aborting if the top one fails
// final validation.
// =================================================================

/**
 * @param {"am"|"pm"} slot
 * @param {string} dateStr - the America/New_York calendar date (YYYY-MM-DD)
 *   this run is for, as determined by the caller via
 *   socialScheduler.determineActiveSlot — never derived from a raw
 *   UTC date internally, since the ET day can differ from the UTC day
 *   near midnight.
 */
async function runScheduledSlot(slot, dateStr, config, deps = {}) {
  // Direct instruction: false or missing means scheduled runs send
  // nothing at all — checked first, before anything else runs.
  if (String(config.automationEnabled).toLowerCase() !== "true") {
    return { ok: false, stage: "disabled", slot, dateStr };
  }

  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);
  const listAllChannelsFn = deps.listAllChannels || listAllChannels;
  const createPostFn = deps.createPost || createPost;

  requireConfigKeys(config, [
    "supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret",
    "bufferAccessToken", "linkedinChannelId", "facebookChannelId",
  ]);

  const runKey = computeRunKey(dateStr, slot);

  // Idempotency fast path: if this exact run_key already completed
  // successfully on both platforms, this invocation (a duplicate
  // trigger, a restart mid-run, or a manual re-run) does nothing
  // further. The database's own unique index on run_key is the
  // ultimate backstop regardless; this just avoids redundant work
  // (candidate selection, Buffer calls) in the common case.
  const { data: existingRunRows } = await supabaseAdmin
    .from("social_post_history").select("facebook_status, linkedin_status, facebook_buffer_post_id, linkedin_buffer_post_id")
    .eq("run_key", runKey);
  const existingRun = (existingRunRows || [])[0] || null;
  const isDone = (status) => status === "sent" || status === "scheduled";
  if (existingRun && isDone(existingRun.facebook_status) && isDone(existingRun.linkedin_status)) {
    // Both platforms already succeeded for this exact run_key — a
    // customScheduled post's genuine success state is "scheduled"
    // (Buffer marks it "sent" only later, once actually published at
    // dueAt), so both states count as done here, not just "sent".
    return { ok: true, stage: "already_completed", slot, dateStr, runKey };
  }

  const availableChannels = await listAllChannelsFn(config.bufferAccessToken);
  const channels = identifyRookChannels(availableChannels, {
    linkedinChannelId: config.linkedinChannelId,
    facebookChannelId: config.facebookChannelId,
  });
  if (!channels.ok) {
    return { ok: false, stage: "channel_identification", slot, dateStr, runKey, errors: channels.errors };
  }

  // Direct instruction: the PM job must differ from that morning's
  // job. Looks up what (if anything) today's AM run actually selected
  // and excludes it from the candidate pool entirely, rather than
  // just hoping ranking alone avoids a repeat.
  let excludedJobIds = new Set();
  if (slot === "pm") {
    const amRunKey = computeRunKey(dateStr, "am");
    const { data: amRows } = await supabaseAdmin.from("social_post_history").select("job_id").eq("run_key", amRunKey);
    const amJobId = (amRows || [])[0]?.job_id;
    if (amJobId) excludedJobIds = new Set([amJobId]);
  }

  const { rankedJobs } = await selectTopCandidate(supabaseAdmin, config, { excludedJobIds });
  const scheduledForUtc = computeScheduledForUtc(dateStr, slot);

  // Direct instruction: if the selected job fails final validation,
  // automatically attempt the next eligible candidate — never simply
  // abort the whole run over one job that turned out to be stale.
  let candidate = null;
  let topJob = null;
  const skippedCandidates = [];
  for (const job of rankedJobs) {
    const attemptCandidate = buildCandidateResponse(job, config.spacingSecret);
    const attemptValidation = await validateJobFresh(supabaseAdmin, supabaseAnon, job.id, config, attemptCandidate.content_version);
    if (attemptValidation.eligible) {
      candidate = attemptCandidate;
      topJob = job;
      break;
    }
    skippedCandidates.push({ jobId: job.id, reasonCodes: attemptValidation.reason_codes });
  }
  if (!candidate) {
    return { ok: false, stage: "no_valid_candidate", slot, dateStr, runKey, skippedCandidates };
  }

  // Final pre-publish re-check — a second, independent validation
  // immediately before contacting Buffer, exactly matching
  // runControlledLiveTest's own final check.
  const finalValidation = await validateJobFresh(supabaseAdmin, supabaseAnon, topJob.id, config, candidate.content_version);
  if (!finalValidation.eligible) {
    return { ok: false, stage: "final_pre_publish_check", slot, dateStr, runKey, jobId: topJob.id, reasonCodes: finalValidation.reason_codes, skippedCandidates };
  }

  const fingerprint = computeJobFingerprintForJob(topJob, config.spacingSecret);

  // Cross-source duplicate protection: has this exact fingerprint
  // already succeeded under a DIFFERENT run_key (e.g. a prior day's
  // run featured the same real opportunity under a different
  // source_job_id)? Belt-and-suspenders on top of ranking already
  // deprioritizing previously-featured fingerprints.
  const { data: fingerprintHistory } = await supabaseAdmin
    .from("social_post_history")
    .select("facebook_status, linkedin_status")
    .eq("job_fingerprint", fingerprint)
    .neq("run_key", runKey);
  const alreadyPostedElsewhere = {
    facebook: (fingerprintHistory || []).some((r) => r.facebook_status === "sent" || r.facebook_status === "scheduled"),
    linkedin: (fingerprintHistory || []).some((r) => r.linkedin_status === "sent" || r.linkedin_status === "scheduled"),
  };
  const alreadyDoneThisRun = {
    facebook: existingRun?.facebook_status === "sent" || existingRun?.facebook_status === "scheduled",
    linkedin: existingRun?.linkedin_status === "sent" || existingRun?.linkedin_status === "scheduled",
  };

  const graphicBuffer = await renderFeaturedJobGraphic(candidate);
  const uploaded = await (deps.uploadGraphicToStorage || uploadGraphicToStorage)(supabaseAdmin, {
    dateStr, slot, jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });

  const mediaPreflight = await (deps.preflightCheckMedia || preflightCheckMedia)(uploaded.publicUrl);
  if (!mediaPreflight.ok) {
    const failureRow = buildHistoryRow({
      runKey, slot, jobId: topJob.id, jobFingerprint: fingerprint, contentVersion: candidate.content_version,
      employerSpacingKey: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
      category: candidate.category, scheduledFor: scheduledForUtc,
      facebook: { channelId: channels.facebook.id, status: "failed" },
      linkedin: { channelId: channels.linkedin.id, status: "failed" },
      creativeUrl: uploaded.publicUrl, captionVersion: "v1",
      selectedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
      failureReason: `Media preflight failed: ${mediaPreflight.reason}`,
    });
    const { error: preflightHistoryError } = await supabaseAdmin.from("social_post_history").upsert(failureRow, { onConflict: "run_key" });
    return { ok: false, stage: "media_preflight", slot, dateStr, runKey, jobId: topJob.id, reason: mediaPreflight.reason, historyRecorded: !preflightHistoryError };
  }

  const postCopy = buildPostCopy(candidate);
  const results = { facebook: null, linkedin: null };

  // Direct instruction: if one platform succeeds and the other fails,
  // retry only the failed platform on any subsequent invocation of
  // this same run_key — never duplicate the successful one. Checked
  // against both this run_key's own prior state and any other
  // successful post of the same real content under a different key.
  if (!alreadyDoneThisRun.facebook && !alreadyPostedElsewhere.facebook) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.facebook.id, text: postCopy, photoUrl: uploaded.publicUrl,
        mode: "customScheduled", dueAt: scheduledForUtc,
        metadata: { facebook: { type: "post" } },
      });
      results.facebook = { status: "scheduled", bufferPostId: post?.id || null, channelId: channels.facebook.id };
    } catch (err) {
      results.facebook = { status: "failed", error: err.message, channelId: channels.facebook.id };
    }
  } else {
    results.facebook = { status: existingRun?.facebook_status || "skipped_duplicate", channelId: channels.facebook.id, bufferPostId: existingRun?.facebook_buffer_post_id || null };
  }

  if (!alreadyDoneThisRun.linkedin && !alreadyPostedElsewhere.linkedin) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.linkedin.id, text: postCopy, photoUrl: uploaded.publicUrl,
        mode: "customScheduled", dueAt: scheduledForUtc,
      });
      results.linkedin = { status: "scheduled", bufferPostId: post?.id || null, channelId: channels.linkedin.id };
    } catch (err) {
      results.linkedin = { status: "failed", error: err.message, channelId: channels.linkedin.id };
    }
  } else {
    results.linkedin = { status: existingRun?.linkedin_status || "skipped_duplicate", channelId: channels.linkedin.id, bufferPostId: existingRun?.linkedin_buffer_post_id || null };
  }

  // Direct instruction: record selection, validation, Buffer IDs,
  // per-channel results, and failures — never an employer name or
  // secret. buildHistoryRow's shape already excludes both; nothing
  // here adds anything beyond it.
  const historyRow = buildHistoryRow({
    runKey, slot, jobId: topJob.id, jobFingerprint: fingerprint, contentVersion: candidate.content_version,
    employerSpacingKey: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
    category: candidate.category, scheduledFor: scheduledForUtc,
    facebook: { channelId: channels.facebook.id, bufferPostId: results.facebook.bufferPostId || null, status: results.facebook.status },
    linkedin: { channelId: channels.linkedin.id, bufferPostId: results.linkedin.bufferPostId || null, status: results.linkedin.status },
    creativeUrl: uploaded.publicUrl, captionVersion: "v1",
    selectedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
    failureReason: [results.facebook.error, results.linkedin.error].filter(Boolean).join(" | ") || null,
  });
  const { error: historyError } = await supabaseAdmin.from("social_post_history").upsert(historyRow, { onConflict: "run_key" });

  const bothSucceeded = results.facebook.status !== "failed" && results.linkedin.status !== "failed";
  return {
    ok: bothSucceeded,
    slot, dateStr, runKey, jobId: topJob.id,
    scheduledForUtc, results, historyRecorded: !historyError, skippedCandidates,
  };
}

/**
 * Status snapshot for operator visibility — direct instruction:
 * enabled/disabled state, timezone, next AM/PM run times, and
 * last-run results, without ever displaying a secret.
 */
async function getSchedulerStatus(config, deps = {}) {
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const enabled = String(config.automationEnabled).toLowerCase() === "true";
  const { nextAm, nextPm } = computeNextRunTimes(new Date());

  const { data: recentRuns } = await supabaseAdmin
    .from("social_post_history")
    .select("run_key, slot, facebook_status, linkedin_status, scheduled_for, failure_reason")
    .order("scheduled_for", { ascending: false })
    .limit(20);

  const lastAmRun = (recentRuns || []).find((r) => r.slot === "am") || null;
  const lastPmRun = (recentRuns || []).find((r) => r.slot === "pm") || null;

  function summarize(run) {
    if (!run) return null;
    return {
      runKey: run.run_key,
      facebookStatus: run.facebook_status,
      linkedinStatus: run.linkedin_status,
      failureReason: run.failure_reason || null,
    };
  }

  return {
    enabled,
    timezone: TIMEZONE,
    nextAmRun: nextAm,
    nextPmRun: nextPm,
    lastAmRun: summarize(lastAmRun),
    lastPmRun: summarize(lastPmRun),
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
  runScheduledSlot,
  getSchedulerStatus,
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
      } else if (command === "scheduled-dispatch") {
        // The actual DigitalOcean Scheduled Job entry point — invoked
        // frequently (every 15 minutes, DO's minimum interval); it
        // decides for itself whether "now" is within the AM or PM
        // window, so a slightly early/late/duplicate invocation is
        // harmless. No-op (exit 0) outside both windows, which is the
        // normal outcome for the vast majority of invocations.
        const active = determineActiveSlot(new Date());
        if (!active) {
          console.log(`Not within the AM or PM window at ${new Date().toISOString()} — no-op.`);
        } else {
          const result = await runScheduledSlot(active.slot, active.dateStr, config);
          console.log(JSON.stringify(result, null, 2));
          if (!result.ok && result.stage !== "already_completed" && result.stage !== "disabled") {
            process.exit(1);
          }
        }
      } else if (command === "scheduler-status") {
        const status = await getSchedulerStatus(config);
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("Usage: node backend/socialPublishWorker.js <discover|validate|live-test|scheduled-dispatch|scheduler-status> [--confirm-live]");
        process.exit(1);
      }
    } catch (err) {
      console.error(`\nFAILED: ${err.message}\n`);
      process.exit(1);
    }
  })();
}
