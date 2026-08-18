// Shared auth helpers for ROOK frontend pages.
// Requires rook-config.js and the Supabase JS CDN script to be loaded first.

const rookSupabase = window.supabase.createClient(
  window.ROOK_CONFIG.SUPABASE_URL,
  window.ROOK_CONFIG.SUPABASE_ANON_KEY
);

// Returns the current session's access token, or null if signed out.
async function rookGetAccessToken() {
  const { data } = await rookSupabase.auth.getSession();
  return data.session ? data.session.access_token : null;
}

// Redirects to the login page if there's no active session.
// Call this at the top of any page that requires the user to be signed in.
async function rookRequireAuth() {
  const token = await rookGetAccessToken();
  if (!token) {
    window.location.href = "rook-login.html";
    return null;
  }
  return token;
}

// Wrapper around fetch() that attaches the Authorization header automatically.
async function rookApiFetch(path, options = {}) {
  const token = await rookGetAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${window.ROOK_CONFIG.API_BASE}${path}`, { ...options, headers });
}

async function rookSignOut() {
  await rookSupabase.auth.signOut();
  window.location.href = "rook-login.html";
}
