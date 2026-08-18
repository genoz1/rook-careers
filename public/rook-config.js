// ROOK frontend config.
//
// SUPABASE_ANON_KEY is safe to expose in browser code — it's the public
// key, restricted by the row-level security policies in backend/db/schema.sql.
// NEVER put the service_role key here.
//
// Fill these in with your real values from Supabase Project Settings > API
// (see ROOK-Setup-Guide.pdf, Section 1.4) before deploying.
window.ROOK_CONFIG = {
  SUPABASE_URL: "YOUR_SUPABASE_PROJECT_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
  API_BASE: "/api",
};
