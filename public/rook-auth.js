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

// Fills in the sidebar's name/avatar/plan card (the ".side-foot" block
// present on every logged-in page) from a real candidate profile object.
// This used to be literal hardcoded text ("Gene Zentko", "Professional
// Plan") baked directly into 8 separate page templates — the plan name
// itself is accurate (ROOK's one paid tier is genuinely branded
// "Professional" on rook-pricing.html), but it was shown unconditionally
// to every candidate regardless of their real subscription_status, and
// the name was always Gene's own. Split out from rookPopulateSidebar()
// below so a page that already has the profile object for another
// reason (the dashboard, for its greeting) can apply it directly
// instead of fetching it a second time.
function rookApplySidebarProfile(profile) {
  if (!profile) return; // fetch failed or no profile row at all — leave the neutral fallback markup in place
  // Name and plan status are independent of each other — a candidate
  // whose profile has no name filled in yet should still see their
  // real plan status, not have the whole card stuck on the neutral
  // placeholder just because one of the two fields is empty. That
  // coupling was itself a bug: reported directly as "the name AND plan
  // no longer show up" together on an account with no name on file.
  const displayName = profile.name?.trim() || profile.email || null;
  if (displayName) {
    const initials = /\s/.test(displayName)
      ? displayName.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
      : displayName.slice(0, 2).toUpperCase();
    document.querySelectorAll('.side-foot .avatar').forEach((el) => { el.textContent = initials; });
    document.querySelectorAll('.side-foot .n').forEach((el) => { el.textContent = displayName; });
  }
  const statusLabel = profile.subscription_status === 'active' ? 'Professional Plan' : 'No Active Subscription';
  document.querySelectorAll('.side-foot .r').forEach((el) => { el.textContent = statusLabel; });
}

// Fetches the candidate's profile and applies it to the sidebar card.
// Use on any page that isn't already fetching /profile for something
// else (the dashboard fetches it anyway for its greeting/profile-gate
// check, so it calls rookApplySidebarProfile directly with that same
// result instead of calling this and fetching twice).
async function rookPopulateSidebar() {
  try {
    const res = await rookApiFetch('/profile');
    if (!res.ok) return;
    rookApplySidebarProfile(await res.json());
  } catch {
    // Best-effort — leave the sidebar's neutral fallback markup in
    // place rather than get stuck if this fails.
  }
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
