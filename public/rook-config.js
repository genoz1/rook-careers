// ROOK frontend config.
//
// SUPABASE_ANON_KEY is safe to expose in browser code — it's the public
// key, restricted by the row-level security policies in backend/db/schema.sql.
// NEVER put the service_role key here.
//
// Fill these in with your real values from Supabase Project Settings > API
// (see ROOK-Setup-Guide.pdf, Section 1.4) before deploying.
window.ROOK_CONFIG = {
  SUPABASE_URL: "https://nazycunakcwfmusmiybd.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5henljdW5ha2N3Zm11c21peWJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNTkyMTMsImV4cCI6MjEwMjYzNTIxM30.t9YQZ0qCuR0fAR2HibU9XVSej5EFm_6t36KaqfmPvEg",
  API_BASE: "/api",
};
