#!/usr/bin/env node
// Buffer publishing worker: discovery, validation, controlled live tests,
// and the scheduled-dispatch entry point for seven-day replenishment.
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
const { isUsEligibleJob } = require("./jobEligibility");
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

const { RECENT_SELECTIONS, rankForCityVariety } = require("./socialCityPreference");

const JOB_COLUMNS = "id, city, state, location_evidence, job_lat, job_lng, employer_id, source_job_id, title_original, location_raw, territory, ai_analysis, compensation_text, salary_min, salary_max, employment_type, remote_status, experience_min_years, company_name, status, moderation_status, social_eligible, expires_at, last_seen_at";

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

// Page through the eligible pool: a single ingestion batch must not hide
// cities/employers beyond Supabase's first page. Fail closed on history errors.
async function fetchSelectionRows(makeQuery, label) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; offset < 100000; offset += pageSize) {
    const { data, error } = await makeQuery().range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Could not query ${label}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
  throw new Error(`${label} exceeds the selection safety limit`);
}

async function selectTopCandidate(supabaseAdmin, config, { excludedJobIds = new Set(), neverFeaturedOnly = false } = {}) {
  const brandedTerms = await fetchBrandedTerms(supabaseAdmin, config);
  const freshSince = new Date(Date.now() - (config.freshnessWindowDays ?? 3) * 86400000).toISOString();
  const rawJobs = await fetchSelectionRows(() => supabaseAdmin.from("jobs").select(JOB_COLUMNS)
    .eq("status", "active").eq("moderation_status", "approved").eq("social_eligible", true)
    .gte("last_seen_at", freshSince).order("last_seen_at", { ascending: false }).order("id"), "candidate jobs");
  const eligibleJobs = rawJobs.filter(job => !excludedJobIds.has(job.id) && isUsEligibleJob(job))
    .filter(job => evaluateEligibility(job, { freshnessWindowDays: config.freshnessWindowDays, brandedTerms }).eligible);
  if (!eligibleJobs.length) throw new Error("No eligible jobs found — nothing available to select for this run");

  const historyColumns = "run_key, job_id, job_fingerprint, employer_spacing_key, category, scheduled_for";
  const histories = await Promise.all(["facebook_status", "linkedin_status"].map(status =>
    fetchSelectionRows(() => supabaseAdmin.from("social_post_history").select(historyColumns)
      .in(status, ["scheduled", "sent"]).order("scheduled_for", { ascending: false }).order("run_key"), "posting history")));
  // One selected job published to two channels counts once for variety.
  const allHistory = [...new Map(histories.flat().map(row => [row.run_key, row])).values()]
    .sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for));
  const fingerprints = new Set(allHistory.map(row => row.job_fingerprint));
  const postedIds = new Set(allHistory.map(row => row.job_id));
  const previouslyFeaturedJobIds = new Set(eligibleJobs
    .filter(job => postedIds.has(job.id) || fingerprints.has(computeJobFingerprintForJob(job, config.spacingSecret))).map(job => job.id));
  const recentHistory = allHistory.slice(0, RECENT_SELECTIONS);
  const recentEmployerSpacingKeys = new Set(recentHistory.map(row => row.employer_spacing_key));
  const recentCategories = recentHistory.slice(0, 4).map(row => row.category).filter(Boolean);
  const historyIds = [...new Set(recentHistory.map(row => row.job_id).filter(Boolean))];
  const historyJobs = new Map(rawJobs.map(job => [job.id, job]));
  const missingIds = historyIds.filter(id => !historyJobs.has(id));
  if (missingIds.length) {
    const { data, error } = await supabaseAdmin.from("jobs").select("id, location_raw").in("id", missingIds);
    if (error) throw new Error(`Could not query recent posting locations: ${error.message}`);
    for (const job of data || []) historyJobs.set(job.id, job);
  }
  const qualityRanked = scoreAndSortCandidates(eligibleJobs, {
    previouslyFeaturedJobIds, recentEmployerSpacingKeys, recentCategories, spacingSecret: config.spacingSecret,
  });
  const ranked = rankForCityVariety(qualityRanked, { previouslyFeaturedJobIds, recentHistory, historyJobs,
    employerKey: job => computeEmployerSpacingKey(job.employer_id, config.spacingSecret) });
  const unused = ranked.filter(job => !neverFeaturedOnly || !previouslyFeaturedJobIds.has(job.id));
  return { topJob: unused[0], rankedJobs: unused, brandedTerms };
}

async function provePublicUrlValid(supabaseAdmin, jobId) {
  // Match the public job page's eligibility gate, including source-country
  // evidence for remote jobs. An active record alone is not a usable page.
  // Public pages read through the server and expose a masked projection.
  // Direct anonymous table reads are intentionally denied by RLS.
  const { data, error } = await supabaseAdmin.from("jobs")
    .select("id, location_raw, location_evidence, job_lat, job_lng, state")
    .eq("id", jobId).eq("status", "active").maybeSingle();
  return !error && Boolean(data) && isUsEligibleJob(data);
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
  const provenPublicUrlValid = await provePublicUrlValid(supabaseAdmin, job.id);
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
  // Validate config BEFORE createClient() — if a key is missing,
  // createClient() throws a cryptic internal "supabaseKey is required"
  // with no indication of which variable is absent. requireConfigKeys
  // must run first so the error names the missing variable.
  requireConfigKeys(config, ["supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret"]);
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);

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

  const postCopyLinkedIn = buildPostCopy(candidate, "linkedin");
  const postCopyFacebook = buildPostCopy(candidate, "facebook");
  const postCopy = postCopyLinkedIn; // default

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

  // Validate config BEFORE createClient() — same reason as
  // runValidationOnly: a missing key must be named clearly.
  requireConfigKeys(config, [
    "supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret",
    "bufferAccessToken", "linkedinChannelId", "facebookChannelId",
  ]);
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);
  const listAllChannelsFn = deps.listAllChannels || listAllChannels;
  const createPostFn = deps.createPost || createPost;

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

  const postCopyLinkedIn = buildPostCopy(candidate, "linkedin");
  const postCopyFacebook = buildPostCopy(candidate, "facebook");
  const postCopy = postCopyLinkedIn; // default
  const results = { facebook: null, linkedin: null };

  if (!alreadyPosted.facebook) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.facebook.id, text: postCopyFacebook, photoUrl: uploaded.publicUrl, mode: "shareNow",
        // Direct fix: Buffer's schema requires this field for Facebook
        // (FacebookPostMetadataInput.type: PostTypeFacebook!,
        // non-nullable) — its absence is exactly the reported
        // "Facebook posts require a type (post, story, or reel)" error.
        metadata: { facebook: { type: "post" } },
      });
      results.facebook = { status: "sent", bufferPostId: post?.id || null, channelId: channels.facebook.id };
    } catch (err) {
      results.facebook = { status: err.capacity ? "deferred_capacity" : "failed", error: err.capacity ? null : err.message, channelId: channels.facebook.id };
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
        channelId: channels.linkedin.id, text: postCopyLinkedIn, photoUrl: uploaded.publicUrl, mode: "shareNow",
      });
      results.linkedin = { status: "sent", bufferPostId: post?.id || null, channelId: channels.linkedin.id };
    } catch (err) {
      results.linkedin = { status: err.capacity ? "deferred_capacity" : "failed", error: err.capacity ? null : err.message, channelId: channels.linkedin.id };
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
// Two-slot worker used by socialQueue's seven-day replenisher. Existing
// validation, ranking, graphics and history are reused. The replenisher adds
// a durable per-channel send ledger and bounded retries around this worker.
// =================================================================

/**
 * @param {"am"|"mid"|"pm"} slot
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

  if (!["am", "pm"].includes(slot)) return { ok: false, stage: "unsupported_slot" };

  // Validate config BEFORE createClient(). The Supabase client library
  // throws its own internal "supabaseKey is required" when passed an
  // undefined key — with no indication of which env var is absent.
  // requireConfigKeys must run first so the DO job log names the exact
  // missing variable (e.g. "Missing required configuration: supabaseAnonKey")
  // rather than surfacing an opaque library-internal error.
  // Public-page eligibility uses the same server-side read and country
  // gate as routes/publicPages.js; anonymous raw-table access stays denied.
  requireConfigKeys(config, [
    "supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret",
    "bufferAccessToken", "linkedinChannelId", "facebookChannelId",
  ]);
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const supabaseAnon = deps.supabaseAnon || createClient(config.supabaseUrl, config.supabaseAnonKey);
  const listAllChannelsFn = deps.listAllChannels || listAllChannels;
  const createPostFn = deps.createPost || createPost;

  const runKey = computeRunKey(dateStr, slot);

  // Idempotency fast path: if this exact run_key already completed
  // successfully on both platforms, this invocation (a duplicate
  // trigger, a restart mid-run, or a manual re-run) does nothing
  // further. The database's own unique index on run_key is the
  // ultimate backstop regardless; this just avoids redundant work
  // (candidate selection, Buffer calls) in the common case.
  const { data: existingRunRows, error: existingRunError } = await supabaseAdmin
    .from("social_post_history").select("*")
    .eq("run_key", runKey);
  if (existingRunError) throw new Error("Cannot read social history");
  const existingRun = (existingRunRows || [])[0] || null;
  const isDone = (status) => status === "sent" || status === "scheduled";
  if (existingRun && isDone(existingRun.facebook_status) && isDone(existingRun.linkedin_status)) {
    if (deps.verifyExistingRun && !deps.verifyExistingRun(existingRun)) return { ok: false, stage: "receipt_reconciliation_required" };
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

  // Each later slot must differ from jobs already selected today.
  let excludedJobIds = new Set();
  for (const earlier of slot === "pm" ? ["am"] : []) {
    const { data: rows, error: earlierError } = await supabaseAdmin.from("social_post_history")
      .select("job_id").eq("run_key", computeRunKey(dateStr, earlier));
    if (earlierError) throw new Error("Cannot read earlier slot history");
    const jobId = (rows || [])[0]?.job_id;
    if (jobId) excludedJobIds.add(jobId);
  }

  // Keep a partial run tied to the same job on both channels.
  let rankedJobs;
  if (existingRun?.job_id) {
    const pinned = await fetchFreshJob(supabaseAdmin, existingRun.job_id);
    rankedJobs = pinned ? [pinned] : [];
  } else {
    ({ rankedJobs } = await selectTopCandidate(supabaseAdmin, config, { excludedJobIds, neverFeaturedOnly: true }));
  }
  const scheduledForUtc = computeScheduledForUtc(dateStr, slot);

  // Direct instruction: if the selected job fails final validation,
  // automatically attempt the next eligible candidate — never simply
  // abort the whole run over one job that turned out to be stale.
  let candidate = null;
  let topJob = null;
  const skippedCandidates = [];
  for (const job of rankedJobs) {
    if (slot === "am" && !String(job.company_name || "").trim()) continue;
    const attemptCandidate = buildCandidateResponse(job, config.spacingSecret);
    const attemptValidation = await validateJobFresh(supabaseAdmin, supabaseAnon, job.id, config, attemptCandidate.content_version);
    if (attemptValidation.eligible && (!attemptValidation.job.expires_at || new Date(attemptValidation.job.expires_at) > scheduledForUtc)) {
      candidate = attemptCandidate;
      topJob = attemptValidation.job;
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

  candidate.post_kind = slot === "am" ? "featured" : "match";
  if (slot === "am") candidate.employer_display = finalValidation.job.company_name;
  const marketing = await (deps.generateMarketing || require("./socialMarketingCopy").generateMarketing)({ slot, category: candidate.category });
  candidate.marketing = marketing.text;
  candidate.marketingVariants = marketing;

  const fingerprint = computeJobFingerprintForJob(topJob, config.spacingSecret);

  // Cross-source duplicate protection: has this exact fingerprint
  // already succeeded under a DIFFERENT run_key (e.g. a prior day's
  // run featured the same real opportunity under a different
  // source_job_id)? Belt-and-suspenders on top of ranking already
  // deprioritizing previously-featured fingerprints.
  const { data: fingerprintHistory, error: fingerprintError } = await supabaseAdmin
    .from("social_post_history")
    .select("facebook_status, linkedin_status")
    .eq("job_fingerprint", fingerprint)
    .neq("run_key", runKey);
  if (fingerprintError) throw new Error("Cannot read duplicate history");
  const alreadyPostedElsewhere = {
    facebook: (fingerprintHistory || []).some((r) => r.facebook_status === "sent" || r.facebook_status === "scheduled"),
    linkedin: (fingerprintHistory || []).some((r) => r.linkedin_status === "sent" || r.linkedin_status === "scheduled"),
  };
  const alreadyDoneThisRun = {
    facebook: existingRun?.facebook_status === "sent" || existingRun?.facebook_status === "scheduled",
    linkedin: existingRun?.linkedin_status === "sent" || existingRun?.linkedin_status === "scheduled",
  };

  if (alreadyPostedElsewhere.facebook || alreadyPostedElsewhere.linkedin) {
    return { ok: false, stage: "duplicate_candidate", runKey };
  }
  // Persist the chosen job before either channel can accept a post.
  const { error: selectionError } = await supabaseAdmin.from("social_post_history").upsert({
    run_key: runKey, slot, job_id: topJob.id, job_fingerprint: fingerprint,
    scheduled_for: scheduledForUtc, job_content_version: candidate.content_version,
    employer_spacing_key: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
    category: candidate.category,
  }, { onConflict: "run_key" });
  if (selectionError) throw new Error("Cannot persist social selection");
  const graphicBuffer = await (deps.renderFeaturedJobGraphic || renderFeaturedJobGraphic)(candidate);
  const uploaded = await (deps.uploadGraphicToStorage || uploadGraphicToStorage)(supabaseAdmin, {
    dateStr, slot, jobId: topJob.id, contentVersion: candidate.content_version, buffer: graphicBuffer,
  });

  const mediaPreflight = await (deps.preflightCheckMedia || preflightCheckMedia)(uploaded.publicUrl);
  if (!mediaPreflight.ok) {
    const failureRow = buildHistoryRow({
      runKey, slot, jobId: topJob.id, jobFingerprint: fingerprint, contentVersion: candidate.content_version,
      employerSpacingKey: computeEmployerSpacingKey(topJob.employer_id, config.spacingSecret),
      category: candidate.category, scheduledFor: scheduledForUtc,
      facebook: { channelId: channels.facebook.id, status: existingRun?.facebook_status || "failed", bufferPostId: existingRun?.facebook_buffer_post_id },
      linkedin: { channelId: channels.linkedin.id, status: existingRun?.linkedin_status || "failed", bufferPostId: existingRun?.linkedin_buffer_post_id },
      creativeUrl: uploaded.publicUrl, captionVersion: "v1",
      selectedAt: new Date().toISOString(), validatedAt: new Date().toISOString(),
      failureReason: `Media preflight failed: ${mediaPreflight.reason}`,
    });
    const { error: preflightHistoryError } = await supabaseAdmin.from("social_post_history").upsert(failureRow, { onConflict: "run_key" });
    return { ok: false, stage: "media_preflight", slot, dateStr, runKey, jobId: topJob.id, reason: mediaPreflight.reason, historyRecorded: !preflightHistoryError };
  }

  const recheck = await validateJobFresh(supabaseAdmin, supabaseAnon, topJob.id, config, candidate.content_version);
  if (!recheck.eligible || (slot === "am" && recheck.job.company_name !== candidate.employer_display) ||
      (recheck.job.expires_at && new Date(recheck.job.expires_at) <= scheduledForUtc)) {
    return { ok: false, stage: "pre_buffer_validation", runKey };
  }
  const postCopyLinkedIn = buildPostCopy(candidate, "linkedin");
  const postCopyFacebook = buildPostCopy(candidate, "facebook");
  const postCopy = postCopyLinkedIn; // default
  const results = { facebook: null, linkedin: null };

  // Direct instruction: if one platform succeeds and the other fails,
  // retry only the failed platform on any subsequent invocation of
  // this same run_key — never duplicate the successful one. Checked
  // against both this run_key's own prior state and any other
  // successful post of the same real content under a different key.
  if (deps.channelAllowed && !deps.channelAllowed(channels.facebook.id) && !alreadyDoneThisRun.facebook) {
    results.facebook = { status: "deferred_capacity", channelId: channels.facebook.id };
  } else if (!alreadyDoneThisRun.facebook && !alreadyPostedElsewhere.facebook) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.facebook.id, text: postCopyFacebook, photoUrl: uploaded.publicUrl,
        mode: "customScheduled", dueAt: scheduledForUtc,
        metadata: { facebook: { type: "post" } },
      });
      results.facebook = { status: "scheduled", bufferPostId: post?.id || null, channelId: channels.facebook.id };
    } catch (err) {
      console.error(`[Buffer] Facebook post failed for run_key=${runKey}: ${err.message}`);
      results.facebook = { status: err.capacity ? "deferred_capacity" : "failed", error: err.capacity ? null : err.message, channelId: channels.facebook.id };
    }
  } else {
    results.facebook = { status: existingRun?.facebook_status || "skipped_duplicate", channelId: channels.facebook.id, bufferPostId: existingRun?.facebook_buffer_post_id || null };
  }

  if (deps.channelAllowed && !deps.channelAllowed(channels.linkedin.id) && !alreadyDoneThisRun.linkedin) {
    results.linkedin = { status: "deferred_capacity", channelId: channels.linkedin.id };
  } else if (!alreadyDoneThisRun.linkedin && !alreadyPostedElsewhere.linkedin) {
    try {
      const post = await createPostFn(config.bufferAccessToken, {
        channelId: channels.linkedin.id, text: postCopyLinkedIn, photoUrl: uploaded.publicUrl,
        mode: "customScheduled", dueAt: scheduledForUtc,
      });
      results.linkedin = { status: "scheduled", bufferPostId: post?.id || null, channelId: channels.linkedin.id };
    } catch (err) {
      console.error(`[Buffer] LinkedIn post failed for run_key=${runKey}: ${err.message}`);
      results.linkedin = { status: err.capacity ? "deferred_capacity" : "failed", error: err.capacity ? null : err.message, channelId: channels.linkedin.id };
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

  const bothSucceeded = isDone(results.facebook.status) && isDone(results.linkedin.status);
  const capacityDeferred = Object.values(results).some(r => r.status === "deferred_capacity") && !Object.values(results).some(r => r.status === "failed");
  return {
    ok: bothSucceeded && !historyError,
    aiFallback: marketing.fallback, capacityDeferred,
    slot, dateStr, runKey, jobId: topJob.id,
    scheduledForUtc, results, historyRecorded: !historyError, skippedCandidates,
  };
}

/**
 * Status snapshot for operator visibility — direct instruction:
 * enabled/disabled state, timezone, next run times, and
 * last-run results, without ever displaying a secret.
 */
async function getSchedulerStatus(config, deps = {}) {
  const supabaseAdmin = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const enabled = String(config.automationEnabled).toLowerCase() === "true";
  const { nextAm, nextMid, nextPm } = computeNextRunTimes(new Date());

  const { data: recentRuns } = await supabaseAdmin
    .from("social_post_history")
    .select("run_key, slot, facebook_status, linkedin_status, scheduled_for, failure_reason")
    .order("scheduled_for", { ascending: false })
    .limit(20);

  const lastAmRun = (recentRuns || []).find((r) => r.slot === "am") || null;
  const lastMidRun = (recentRuns || []).find((r) => r.slot === "mid") || null;
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
    nextMidRun: nextMid,
    nextPmRun: nextPm,
    lastAmRun: summarize(lastAmRun),
    lastMidRun: summarize(lastMidRun),
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
        const result = await require("./socialQueue").replenish(config);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
      } else if (command === "dry-run-dispatch") {
        // Safe out-of-window test — runs the full scheduled-dispatch
        // logic (config check, candidate selection, validation, graphic
        // render) but does NOT call Buffer and does NOT write to
        // social_post_history. No duplicate risk; safe to run any time.
        // Usage:
        //   node backend/socialPublishWorker.js dry-run-dispatch --slot am
        //   node backend/socialPublishWorker.js dry-run-dispatch --slot pm
        const slotArg = rest.find((_, i) => rest[i - 1] === "--slot") || rest[rest.indexOf("--slot") + 1];
        if (!["am", "mid", "pm"].includes(slotArg)) {
          console.error("Usage: dry-run-dispatch --slot am|mid|pm");
          process.exit(1);
        }
        // requireConfigKeys validates all env vars before touching anything
        requireConfigKeys(config, [
          "supabaseUrl", "supabaseServiceRoleKey", "supabaseAnonKey", "spacingSecret",
          "bufferAccessToken", "linkedinChannelId", "facebookChannelId",
        ]);
        const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
        const supabaseAnon = createClient(config.supabaseUrl, config.supabaseAnonKey);
        const fakeDateStr = new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
        const fakeRunKey = `DRY-RUN-${fakeDateStr}-${slotArg.toUpperCase()}`;
        console.log(`\n[dry-run-dispatch] slot=${slotArg} date=${fakeDateStr} runKey=${fakeRunKey}`);
        console.log("[dry-run-dispatch] No Buffer calls. No database writes. Safe at any time.\n");
        const { rankedJobs } = await selectTopCandidate(supabaseAdmin, config);
        const skippedCandidates = [];
        let candidate = null, topJob = null;
        for (const job of rankedJobs) {
          const attemptCandidate = buildCandidateResponse(job, config.spacingSecret);
          const attemptValidation = await validateJobFresh(supabaseAdmin, supabaseAnon, job.id, config, attemptCandidate.content_version);
          if (attemptValidation.eligible) { candidate = attemptCandidate; topJob = job; break; }
          skippedCandidates.push({ jobId: job.id, reasonCodes: attemptValidation.reason_codes });
        }
        if (!candidate) {
          console.log(JSON.stringify({ ok: false, stage: "no_valid_candidate", slotArg, fakeDateStr, skippedCandidates }, null, 2));
          process.exit(0);
        }
        const graphicBuffer = await renderFeaturedJobGraphic(candidate);
        console.log(JSON.stringify({
          ok: true, stage: "dry_run_complete", slot: slotArg, dateStr: fakeDateStr,
          runKey: fakeRunKey, jobId: topJob.id,
          title: topJob.title_original, company: topJob.company_name,
          category: candidate.category, contentVersion: candidate.content_version,
          graphicBytes: graphicBuffer?.length || 0,
          skippedCandidates,
          note: "Buffer was NOT called. social_post_history was NOT written.",
        }, null, 2));
      } else if (command === "scheduler-status") {
        const status = await getSchedulerStatus(config);
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("Usage: node backend/socialPublishWorker.js <discover|validate|live-test|dry-run-dispatch|scheduled-dispatch|scheduler-status> [--confirm-live] [--slot am|mid|pm]");
        process.exit(1);
      }
    } catch (err) {
      console.error(`\nFAILED: ${err.message}\n`);
      process.exit(1);
    }
  })();
}
