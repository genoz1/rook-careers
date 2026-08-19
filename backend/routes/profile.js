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

  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  } else {
    analysisStatus = "no_text_extracted";
  }

  // Upsert, not update — a brand-new user uploading a résumé on
  // onboarding Step 1 doesn't have a candidate_profiles row yet (that's
  // only created by the PUT /profile call on Step 7). Using update()
  // here would previously silently affect zero rows for new users,
  // meaning the file path never actually saved.
  const { error: dbError } = await supabaseAdmin
    .from("candidate_profiles")
    .upsert(
      {
        user_id: req.user.id,
        resume_file_path: filePath,
        resume_text: resumeText,
        resume_structured: resumeStructured,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  if (dbError) return res.status(500).json({ error: dbError.message });

  res.json({ ok: true, path: filePath, analysis_status: analysisStatus });
});

module.exports = router;
