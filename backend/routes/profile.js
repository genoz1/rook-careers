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

  // If a ZIP was provided, geocode it once here so home_lat/home_lng save
  // in the same write — powers the proximity bonus in backend/matching.js.
  // A geocoding failure doesn't block saving the rest of the profile; it
  // just means no proximity bonus until a later save succeeds.
  if (payload.home_zip) {
    try {
      const coords = await geocodeZip(payload.home_zip);
      if (coords) {
        payload.home_lat = coords.lat;
        payload.home_lng = coords.lng;
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
