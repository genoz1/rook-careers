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
// loginPage defaults to the candidate login page — pass
// "rook-recruiter-login.html" from recruiter pages so a signed-out
// recruiter lands on the correct login screen, not the candidate one.
async function rookRequireAuth(loginPage = "rook-login.html") {
  const token = await rookGetAccessToken();
  if (!token) {
    window.location.href = loginPage;
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

async function rookSignOut(loginPage = "rook-login.html") {
  await rookSupabase.auth.signOut();
  window.location.href = loginPage;
}

// Sends a just-authenticated candidate to onboarding or the dashboard,
// depending on whether they've actually completed a profile yet (GET
// /api/profile returns null until Step 7 of onboarding has been
// submitted). Used after normal sign-in AND after password reset — those
// used to be two separate, drifted implementations. Password reset had
// its own hardcoded redirect straight to the dashboard with no profile
// check at all, which is how a brand-new candidate who signed up, mistyped
// their password, and reset it ended up on an empty, unscored dashboard
// having never seen onboarding.
async function rookRouteAfterLogin() {
  try {
    const res = await rookApiFetch('/profile');
    const profile = res.ok ? await res.json() : null;
    window.location.href = profile ? 'rook-dashboard.html' : 'rook-onboarding.html';
  } catch {
    // Fall back to onboarding, not the dashboard, when the check itself
    // fails (network blip, backend not configured, etc.) — the safe
    // default on an uncertain check is to route toward setup, not away
    // from it.
    window.location.href = 'rook-onboarding.html';
  }
}
