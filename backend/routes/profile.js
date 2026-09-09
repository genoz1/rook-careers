// Candidate profile + résumé upload routes.
//
// Auth model: the frontend signs users in directly with Supabase Auth
// (supabase-js in the browser) and sends the resulting access token in
// the Authorization header on every request here. This backend verifies
// that token with the ANON key client, then uses the SERVICE ROLE client
// only for the specific write the request needs.

const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const { extractResumeText } = require("../resumeParser");
const { analyzeResume } = require("../ai/resumeAnalysis");
const { generateEmbedding } = require("../ai/embeddings");
const { suggestRoles } = require("../ai/roleSuggestions");
const { scoreAndStoreForCandidate } = require("../scoring/precompute");
const { geocodeZip } = require("../geocoding");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Guard against missing config the same way as backend/routes/stripe.js —
// createClient() throws synchronously on an undefined URL, which would
// otherwise crash the whole server on startup rather than just this route.
const isConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured) {
    return res.status(503).json({ error: "Supabase isn't configured on this server yet. See ROOK-Setup-Guide.pdf." });
  }
  next();
}

// Verifies the caller's Supabase access token and attaches req.user.
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });

  req.user = data.user;
  next();
}

// GET /api/profile — the caller's own candidate profile
// POST /api/profile/prefill
// Saves questionnaire answers immediately after signUp(), before email
// verification. The client sends the new user's ID (returned by signUp)
// and the questionnaire data. No session is required — this endpoint is
// called before the user has verified their email.
//
// Security:
//   - Rate-limited to 5 requests per minute per IP.
//   - Only writes questionnaire fields (industry, years, territory, location).
//   - Never writes subscription_status, resume data, or any privileged field.
//   - Uses supabaseAdmin to write — the user_id is from the signUp response
//     which is a real Supabase UUID; a forged UUID would just create an
//     orphan row that is never accessible.
//
// Purpose: solves the iOS cross-browser problem where the verification email
// opens in Safari but the user signed up in Chrome. localStorage is
// browser-scoped so the draft is unavailable in Safari. With this endpoint,
// the questionnaire is already in the DB when the verification link opens.
const prefillRate = new Map();
// POST /api/onboarding/pre-verify-upload
// Accepts a résumé file BEFORE email verification using the user_id returned
// by signUp(). Stores the file, runs AI analysis, and starts background
// scoring so results are ready when the user clicks their verification link.
//
// Security: validates user_id exists in Supabase Auth via admin API before
// touching storage or the database. Rate-limited to prevent abuse.
// Only writes résumé + profile fields; never writes subscription data.
const preVerifyRate = new Map();
const preVerifyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post("/onboarding/pre-verify-upload", requireConfig, preVerifyUpload.single("resume"), async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const e = preVerifyRate.get(ip);
  if (e && now < e.resetAt && e.count >= 4) return res.status(429).json({ ok: false, error: "Too many requests" });
  if (!e || now >= e.resetAt) preVerifyRate.set(ip, { count: 1, resetAt: now + 600_000 }); // 4 per 10 min
  else e.count++;

  const { user_id, zip } = req.body;
  if (!user_id || !/^[0-9a-f-]{36}$/.test(user_id)) return res.status(400).json({ ok: false, error: "Invalid user_id" });
  if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

  // Validate user exists in Supabase before touching storage
  const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.getUserById(user_id);
  if (authErr || !authUser?.user) return res.status(400).json({ ok: false, error: "User not found" });

  const filePath = `${user_id}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const { error: uploadErr } = await supabaseAdmin.storage
    .from("resumes").upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (uploadErr) return res.status(500).json({ ok: false, error: uploadErr.message });

  // Run analysis in background — respond immediately so check-email screen can update
  res.json({ ok: true, path: filePath, status: "processing" });

  // Background pipeline: extract → analyze → embed → save → score
  (async () => {
    try {
      let resumeText = null, resumeStructured = null, resumeEmbedding = null, suggestedRoles = null;
      let analysisStatus = "skipped";

      try { resumeText = await extractResumeText(req.file.buffer, req.file.mimetype); } catch (_) {}

      if (resumeText) {
        try { resumeStructured = await analyzeResume(resumeText); analysisStatus = "ok"; } catch (_) { analysisStatus = "failed"; }
        try { resumeEmbedding = await generateEmbedding(resumeText); } catch (_) {}
        if (resumeStructured) { try { suggestedRoles = await suggestRoles(resumeStructured); } catch (_) {} }
      } else { analysisStatus = "no_text_extracted"; }

      // Use lat/lng from location widget if provided (already geocoded client-side)
      // Fall back to ZIP geocoding only when coordinates aren't supplied.
      let geoFields = {};
      const clientLat = parseFloat(req.body.lat);
      const clientLng = parseFloat(req.body.lng);
      if (!isNaN(clientLat) && !isNaN(clientLng)) {
        geoFields = { home_lat: clientLat, home_lng: clientLng };
        if (zip) geoFields.home_zip = zip;
        console.log(`[pre-verify-upload] using client coords lat=${clientLat} lng=${clientLng}`);
      } else if (zip && /^\d{5}$/.test(zip)) {
        try {
          const coords = await geocodeZip(zip);
          if (coords) {
            geoFields = { home_zip: zip, home_lat: coords.lat, home_lng: coords.lng, ...(coords.state ? { home_state: coords.state } : {}) };
            console.log(`[pre-verify-upload] geocoded zip=${zip} lat=${coords.lat} state=${coords.state}`);
          } else {
            console.warn(`[pre-verify-upload] geocodeZip returned null for zip=${zip}`);
          }
        } catch (geoErr) {
          console.error(`[pre-verify-upload] geocoding failed for zip=${zip}: ${geoErr.message}`);
        }
      } else {
        console.warn(`[pre-verify-upload] no valid zip or coords provided`);
      }

      const payload = { user_id, resume_file_path: filePath, updated_at: new Date().toISOString(), ...geoFields };
      if (resumeText)       payload.resume_text       = resumeText;
      if (resumeStructured) payload.resume_structured = resumeStructured;
      if (resumeEmbedding)  payload.candidate_embedding = resumeEmbedding;
      if (suggestedRoles)   payload.suggested_roles   = suggestedRoles;
      // analysis_status is NOT written — column does not exist in candidate_profiles
      console.log(`[pre-verify-upload] uid=${user_id.slice(0,8)} analysis=${analysisStatus} has_structured=${!!resumeStructured} has_embedding=${!!resumeEmbedding} has_location=${!!geoFields.home_lat}`);

      const { data: profile, error: dbErr } = await supabaseAdmin.from("candidate_profiles")
        .upsert(payload, { onConflict: "user_id" }).select().single();
      if (dbErr) { console.error("[pre-verify-upload] db:", dbErr.message); return; }

      console.log(`[pre-verify-upload] uid=${user_id.slice(0,8)} analysis=${analysisStatus}`);

      // Score in background if analysis succeeded
      if (profile && analysisStatus === "ok") {
        scoreAndStoreForCandidate(supabaseAdmin, profile)
          .then(r => console.log(`[pre-verify-upload] scored ${r.scoredCount} jobs for uid=${user_id.slice(0,8)}`))
          .catch(err => console.error("[pre-verify-upload] scoring:", err.message));
      }
    } catch (err) {
      console.error("[pre-verify-upload] pipeline:", err.message);
    }
  })();
});

// POST /api/onboarding/pre-verify-status
// Polls processing status for a pre-verified user. Returns current profile
// state so the check-email screen can show real progress.
router.get("/onboarding/pre-verify-status/:user_id", requireConfig, async (req, res) => {
  const { user_id } = req.params;
  if (!user_id || !/^[0-9a-f-]{36}$/.test(user_id)) return res.status(400).json({ ok: false });
  // Rate-limit status polling
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const key = `status:${ip}`;
  const now = Date.now();
  const se = preVerifyRate.get(key);
  if (se && now < se.resetAt && se.count >= 60) return res.status(429).json({ ok: false });
  if (!se || now >= se.resetAt) preVerifyRate.set(key, { count: 1, resetAt: now + 60_000 });
  else se.count++;

  const { data: profile } = await supabaseAdmin.from("candidate_profiles")
    .select("resume_structured, resume_file_path, candidate_embedding")
    .eq("user_id", user_id).maybeSingle();
  res.json({
    ok: true,
    analysis_status: profile?.resume_structured ? 'ok' : (profile?.resume_file_path ? 'processing' : null),
    has_resume: !!profile?.resume_file_path,
    scoring_ready: !!profile?.candidate_embedding
  });
});

router.post("/profile/prefill", requireConfig, async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const e = prefillRate.get(ip);
  if (e && now < e.resetAt && e.count >= 5) return res.status(429).json({ ok: false });
  if (!e || now >= e.resetAt) prefillRate.set(ip, { count: 1, resetAt: now + 60_000 });
  else e.count++;

  const { user_id, desired_industries, total_sales_years, territory_size_preferences,
    territory_size_preference, work_style, home_city, home_state, home_zip,
    home_lat, home_lng, home_location_label, trigger_scoring } = req.body;

  if (!user_id || typeof user_id !== "string" || !/^[0-9a-f-]{36}$/.test(user_id)) {
    return res.status(400).json({ ok: false, error: "Invalid user_id" });
  }

  const payload = {
    user_id,
    updated_at: new Date().toISOString(),
    ...(Array.isArray(desired_industries)    ? { desired_industries }    : {}),
    ...(total_sales_years != null            ? { total_sales_years }     : {}),
    ...(territory_size_preferences != null   ? { territory_size_preferences } : {}),
    ...(territory_size_preference != null    ? { territory_size_preference }  : {}),
    ...(work_style                           ? { work_style }             : {}),
    ...(home_city                            ? { home_city }              : {}),
    ...(home_state                           ? { home_state }             : {}),
    ...(home_zip                             ? { home_zip }               : {}),
    ...(home_lat != null                     ? { home_lat }               : {}),
    ...(home_lng != null                     ? { home_lng }               : {}),
    ...(home_location_label                  ? { home_location_label }    : {}),
  };

  try {
    const { error } = await supabaseAdmin.from("candidate_profiles")
      .upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    console.log(`[profile/prefill] saved for uid=${user_id.slice(0,8)} location=${home_state || "none"}`);

    // When the client requests scoring (v5 onboarding — questionnaire-only path),
    // trigger scoreAndStoreForCandidate in background so results are ready
    // before the user clicks their verification link.
    if (trigger_scoring && home_lat) {
      const { data: profile } = await supabaseAdmin.from("candidate_profiles")
        .select("*").eq("user_id", user_id).maybeSingle();
      if (profile) {
        scoreAndStoreForCandidate(supabaseAdmin, profile)
          .then(r => console.log(`[profile/prefill] scored ${r?.scoredCount || 0} jobs for uid=${user_id.slice(0,8)}`))
          .catch(err => console.error("[profile/prefill] scoring:", err.message));
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[profile/prefill]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/profile", requireConfig, requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// PUT /api/profile — create or update the caller's candidate profile
router.put("/profile", requireConfig, requireAuth, async (req, res) => {
  const payload = { ...req.body, user_id: req.user.id, updated_at: new Date().toISOString() };

  // First-touch UTM attribution: set once, at whichever save is this
  // candidate's first (normally onboarding), then never touched again —
  // a later Settings edit re-sending the same locally-cached values
  // would be harmless, but this guard makes that explicit rather than
  // relying on the frontend to behave, and protects against a stale
  // browser-cached attribution value from a much earlier visit
  // clobbering a real one already on file.
  const UTM_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  const { data: existingRow } = await supabaseAdmin
    .from("candidate_profiles")
    .select("utm_source")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (existingRow?.utm_source) {
    UTM_FIELDS.forEach((field) => delete payload[field]);
  } else {
    UTM_FIELDS.forEach((field) => {
      if (typeof payload[field] === "string") payload[field] = payload[field].trim().slice(0, 200);
      else delete payload[field];
    });
  }

  // If a ZIP was provided AND lat/lng were NOT already supplied by the caller
  // (e.g. from the location-autocomplete widget which sends real coordinates
  // for any city or ZIP selection), geocode the ZIP to get coordinates.
  // When the caller already provides home_lat/home_lng (city selections), skip
  // this geocoding so we don't clobber precise coordinates with a ZIP-centroid.
  if (payload.home_zip && payload.home_lat == null && payload.home_lng == null) {
    try {
      const coords = await geocodeZip(payload.home_zip);
      if (coords) {
        payload.home_lat = coords.lat;
        payload.home_lng = coords.lng;
        // Also capture the state name if not already provided
        if (!payload.home_state && coords.state) payload.home_state = coords.state;
      }
    } catch (err) {
      console.error(`Geocoding failed for ZIP ${payload.home_zip}: ${err.message}`);
    }
  }

  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);

  // Fire-and-forget rescore — location, comp expectations, travel limits,
  // and desired industries all feed directly into scoring, so a profile
  // edit should refresh this candidate's stored scores promptly rather
  // than waiting for the next scheduled precompute run. Deliberately
  // not awaited: scoring against a large active-job pool can take a
  // couple of seconds, and there's no reason to make the save itself
  // feel slow for that — a page loaded a few seconds later will already
  // see fresh scores either way.
  scoreAndStoreForCandidate(supabaseAdmin, data)
    .then(({ scoredCount }) => {
      console.log(`Rescore after profile update succeeded for candidate ${data.id}: ${scoredCount} job(s) scored.`);
    })
    .catch((err) => {
      console.error(`Rescore after profile update failed for candidate ${data.id}: ${err.message}`);
    });
});

// POST /api/resume — upload a résumé, extract its text, and run AI
// analysis to produce structured data the matching engine can use
// (industries, product categories, customer types, seniority, etc.).
//
// Every step after the file upload itself is best-effort: if text
// extraction fails (e.g. a legacy .doc file) or the AI call fails (no
// API key configured, API error, malformed response), the upload still
// succeeds and returns a clear status on what worked. A résumé upload
// should never fail just because analysis had a hiccup.
router.post("/resume", requireConfig, requireAuth, upload.single("resume"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = `${req.user.id}/${Date.now()}-${req.file.originalname}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("resumes")
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  let resumeText = null;
  let resumeStructured = null;
  let resumeEmbedding = null;
  let suggestedRoles = null;
  let analysisStatus = "skipped";

  try {
    resumeText = await extractResumeText(req.file.buffer, req.file.mimetype);
  } catch (err) {
    console.error(`Resume text extraction threw: ${err.message}`);
  }

  if (resumeText) {
    try {
      resumeStructured = await analyzeResume(resumeText);
      analysisStatus = "ok";
    } catch (err) {
      console.error(`Resume AI analysis failed: ${err.message}`);
      analysisStatus = "failed";
    }

    // Embedding generation is independent of the structured analysis —
    // one failing doesn't block the other, since they serve different
    // parts of the matching engine (category matching vs. semantic
    // similarity).
    try {
      resumeEmbedding = await generateEmbedding(resumeText);
    } catch (err) {
      console.error(`Resume embedding generation failed: ${err.message}`);
    }

    // Role suggestions computed once here, alongside the rest of the
    // analysis, rather than live on every Career Intelligence page
    // visit — same "analyze once, read many times" pattern as
    // resume_structured itself. Needs resumeStructured to have
    // succeeded first (it's the input), so this only runs if that did.
    if (resumeStructured) {
      try {
        suggestedRoles = await suggestRoles(resumeStructured);
      } catch (err) {
        console.error(`Role suggestion failed: ${err.message}`);
      }
    }
  } else {
    analysisStatus = "no_text_extracted";
  }

  // Upsert, not update — a brand-new user uploading a résumé on
  // onboarding Step 1 doesn't have a candidate_profiles row yet (that's
  // only created by the PUT /profile call on Step 7). Using update()
  // here would previously silently affect zero rows for new users,
  // meaning the file path never actually saved.
  //
  // CRITICAL: only include resume_text/resume_structured/
  // candidate_embedding/suggested_roles in the payload when THIS
  // attempt actually produced a value. Earlier versions of this route
  // always included them — even as null when extraction or analysis
  // failed — which meant a failed re-upload silently wiped out
  // previously-good résumé data, since Supabase upsert writes whatever
  // columns are present in the payload, null or not. resume_file_path
  // is the exception: the file itself did genuinely upload regardless
  // of downstream analysis success, so that always updates.
  const updatePayload = {
    user_id: req.user.id,
    resume_file_path: filePath,
    updated_at: new Date().toISOString(),
  };
  if (resumeText) updatePayload.resume_text = resumeText;
  if (resumeStructured) updatePayload.resume_structured = resumeStructured;
  if (resumeEmbedding) updatePayload.candidate_embedding = resumeEmbedding;
  if (suggestedRoles) updatePayload.suggested_roles = suggestedRoles;

  const { data: updatedProfile, error: dbError } = await supabaseAdmin
    .from("candidate_profiles")
    .upsert(updatePayload, { onConflict: "user_id" })
    .select()
    .single();

  if (dbError) return res.status(500).json({ error: dbError.message });

  res.json({
    ok: true,
    path: filePath,
    analysis_status: analysisStatus,
    // Include the structured result directly so the onboarding UI can
    // populate the Career Experience step from THIS response, instead
    // of needing a second round-trip. Previously this response only
    // returned analysis_status, never the actual data — meaning the
    // frontend always fell back to "couldn't automatically read your
    // work history" regardless of whether extraction actually
    // succeeded, since the field it was checking simply wasn't here.
    resume_structured: resumeStructured,
  });

  // Fire-and-forget rescore — a new résumé changes candidate_fit
  // substantially (industries, product categories, seniority, the
  // semantic embedding), so this candidate's stored scores should
  // refresh right away rather than waiting for the next scheduled
  // precompute run. Same not-awaited reasoning as the PUT /profile
  // rescore trigger — the upload response shouldn't wait on scoring
  // potentially thousands of jobs.
  scoreAndStoreForCandidate(supabaseAdmin, updatedProfile)
    .then(({ scoredCount }) => {
      console.log(`Rescore after resume upload succeeded for candidate ${updatedProfile.id}: ${scoredCount} job(s) scored.`);
    })
    .catch((err) => {
      console.error(`Rescore after resume upload failed for candidate ${updatedProfile.id}: ${err.message}`);
    });
});

// GET /api/resume-url — a signed download link plus display info (real
// filename, upload date) for the caller's current résumé. "My Résumés"
// in the sidebar used to link straight into onboarding's upload step
// with zero indication of what was actually on file already — reported
// directly as "shouldn't it actually show my résumés?" resume_file_path
// itself is the only thing stored (no separate filename/timestamp
// columns), but the upload route names each file
// `{timestamp}-{originalFilename}`, so both are recoverable straight
// from the path without a schema change.
router.get("/resume-url", requireConfig, requireAuth, async (req, res) => {
  const { data: profile, error } = await supabaseAdmin
    .from("candidate_profiles")
    .select("resume_file_path")
    .eq("user_id", req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!profile?.resume_file_path) return res.json(null);

  const rawName = profile.resume_file_path.split("/").pop() || "";
  const match = rawName.match(/^(\d+)-(.+)$/);
  const uploadedAt = match ? new Date(Number(match[1])).toISOString() : null;
  const filename = match ? match[2] : rawName;

  try {
    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from("resumes")
      .createSignedUrl(profile.resume_file_path, 60 * 60); // 1 hour — just for viewing/downloading right now, not a link meant to be saved anywhere
    if (signError) throw signError;
    res.json({ url: signed?.signedUrl || null, filename, uploaded_at: uploadedAt });
  } catch (err) {
    res.status(500).json({ error: `Could not generate a link to your résumé: ${err.message}` });
  }
});

module.exports = router;
