// ROOK first-touch ad attribution.
//
// Captures utm_source/utm_medium/utm_campaign/utm_term/utm_content/utm_id from
// the landing URL (if present) and stores them in localStorage — once.
// First-touch, not last-touch: if someone clicks a Google ad today,
// browses around organically for a week, then signs up, this preserves
// "Google" as the original source rather than being overwritten by
// whatever brought them back later. That's what answers "did this
// trial/conversion come from Google, LinkedIn, Facebook, or organic" —
// the channel that actually earned the first visit.
//
// Included directly (not bundled) on any page an ad could land someone
// on. Safe to include on every page — a no-op after the first capture.
(function () {
  var STORAGE_KEY = 'rook_attribution_v1';

  function alreadyCaptured() {
    try {
      return Boolean(localStorage.getItem(STORAGE_KEY));
    } catch {
      return true; // storage blocked/unavailable — don't keep retrying every page load
    }
  }

  function captureFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'];
    var found = {};
    var any = false;
    fields.forEach(function (key) {
      var val = params.get(key);
      if (val) {
        found[key] = val.slice(0, 200); // matches the backend's own cap
        any = true;
      }
    });
    // Google auto-tagging identifies paid traffic even without manual UTMs.
    if (params.get('gclid') || params.get('gbraid') || params.get('wbraid')) {
      found.utm_source = found.utm_source || 'google';
      found.utm_medium = found.utm_medium || 'cpc';
      any = true;
    }
    // Meta click IDs identify Facebook/Instagram paid traffic without UTMs.
    if (params.get('fbclid')) {
      found.utm_source = found.utm_source || 'facebook';
      found.utm_medium = found.utm_medium || 'paid_social';
      any = true;
    }
    if (!any) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(found));
    } catch {
      // Storage full/blocked (private browsing, etc.) — non-fatal, this
      // visitor's attribution just won't be captured this visit.
    }
  }

  if (!alreadyCaptured()) captureFromUrl();
})();

// Returns the stored first-touch UTM object (possibly empty {}), for
// any page that needs to forward it — onboarding's profile save, or
// the pricing page's checkout call.
function rookGetStoredAttribution() {
  try {
    var raw = localStorage.getItem('rook_attribution_v1');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Shared event enrichment. Current visit source and original acquisition remain
// separate: a returning LinkedIn visit must not rewrite an earlier Meta touch.
function rookAttributionEventParams(profile) {
  var a = profile && profile.utm_source ? profile : rookGetStoredAttribution();
  var out = {};
  ['source','medium','campaign','content','term','id'].forEach(function(k) {
    var v = a['utm_'+k];
    if (typeof v === 'string' && !/@|https?:\/\//i.test(v)) out['first_touch_'+k] = v.slice(0,100);
  });
  var query = new URLSearchParams(window.location.search);
  var source = query.get('utm_source') ||
    ((query.get('gclid') || query.get('gbraid') || query.get('wbraid')) ? 'google' : '') || a.utm_source;
  if (!source) {
    try {
      var ref = new URL(document.referrer);
      source = ref.hostname === window.location.hostname ? 'direct' :
        /(^|\.)linkedin\.com$/.test(ref.hostname) ? 'linkedin' :
        /(^|\.)google\.[a-z.]+$/.test(ref.hostname) ? 'google' : 'referral';
    } catch (_) { source = 'direct'; }
  }
  if (typeof source === 'string' && /^[a-z0-9_ -]{1,50}$/i.test(source)) out.source = source;
  return out;
}
