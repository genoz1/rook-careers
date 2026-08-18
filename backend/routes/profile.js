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

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
router.get("/profile", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

// PUT /api/profile — create or update the caller's candidate profile
router.put("/profile", requireAuth, async (req, res) => {
  const payload = { ...req.body, user_id: req.user.id, updated_at: new Date().toISOString() };

  const { data, error } = await supabaseAdmin
    .from("candidate_profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/resume — upload a résumé file to Supabase Storage and store
// its path on the candidate's profile. Text extraction and AI parsing
// (architecture spec section 8) are intentionally NOT done here yet —
// this route only handles the upload + storage side.
router.post("/resume", requireAuth, upload.single("resume"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const filePath = `${req.user.id}/${Date.now()}-${req.file.originalname}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("resumes")
    .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (uploadError) return res.status(500).json({ error: uploadError.message });

  const { error: dbError } = await supabaseAdmin
    .from("candidate_profiles")
    .update({ resume_file_path: filePath, updated_at: new Date().toISOString() })
    .eq("user_id", req.user.id);

  if (dbError) return res.status(500).json({ error: dbError.message });

  res.json({ ok: true, path: filePath });
});

module.exports = router;
