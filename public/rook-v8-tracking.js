// Current paid-funnel Meta + GA tracking. Pixel 1597398388509281.
// Paid conversion uses Purchase (not Subscribe/StartTrial).
(function () {
  if (window.rookTrackFunnelEvent) return;
  var pixel = '1597398388509281';
  var planValues = { two_day: 5.99, monthly: 9.99, three_month: 39.99 };
  var meta = {
    onboarding_started: ['trackSingleCustom', 'onboarding_started'],
    v7_questions_completed: ['trackSingleCustom', 'v7_questions_completed'],
    v7_masked_dashboard_viewed: ['trackSingle', 'ViewContent'],
    v7_unlock_clicked: ['trackSingleCustom', 'v7_unlock_clicked'],
    v7_signup_started: ['trackSingleCustom', 'v7_signup_started'],
    v7_account_created: ['trackSingle', 'CompleteRegistration'],
    v7_checkout_started: ['trackSingle', 'InitiateCheckout'],
    // Current acquisition / checkout events (served via rook-checkout-current).
    // One ViewContent per visit when masked roles render — avoid double-firing
    // with acquisition_landing_viewed.
    protected_dashboard_viewed: ['trackSingle', 'ViewContent'],
    checkout_started: ['trackSingle', 'InitiateCheckout'],
    successful_paid_conversion: ['trackSingle', 'Purchase'],
    v8_signup_started: ['trackSingleCustom', 'v8_signup_started'],
    v8_account_created: ['trackSingle', 'CompleteRegistration'],
    v8_checkout_started: ['trackSingle', 'InitiateCheckout']
    // Intentionally no StartTrial / Subscribe mappings — ROOK is paid-only.
  };
  var seen = Object.create(null);
  var currentEvents = ['acquisition_landing_viewed','protected_dashboard_viewed','ip_geolocation_success','ip_geolocation_failure','change_location_clicked','location_changed','anonymous_job_interaction','pricing_paywall_viewed','membership_plan_selected','checkout_viewed','checkout_started','successful_paid_conversion'];
  // No advanced matching, automatic form detection, or automatic events.
  if (!window.fbq) {
    var q = window.fbq = function () {
      q.callMethod ? q.callMethod.apply(q, arguments) : q.queue.push(arguments);
    };
    window._fbq = q; q.push = q; q.loaded = true; q.version = '2.0'; q.queue = [];
    var script = document.createElement('script'); script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(script);
  }
  window.fbq('set', 'autoConfig', false, pixel);
  window.fbq('init', pixel);
  window.fbq('trackSingle', pixel, 'PageView');

  window.rookTrackFunnelEvent = function (name, params, accountScope) {
    try {
      var mapping = meta[name];
      var storage = accountScope ? localStorage : sessionStorage;
      var scope = accountScope || sessionStorage.getItem('rook_v7_token') || 'visit';
      var key = 'rook_funnel_v1:' + name + ':' + scope;
      if (mapping || name === 'sign_up' || /^v8_/.test(name) || currentEvents.indexOf(name) !== -1) {
        if (seen[key]) return;
        try { if (storage.getItem(key)) return; } catch (_) {}
        seen[key] = true;
        try { storage.setItem(key, '1'); } catch (_) {}
      }
      var safe = {onboarding_version: 'v8'};
      if (sessionStorage.getItem('rook_acquisition_origin') === 'medreps-alternative') safe.acquisition_page = 'medreps-alternative';
      // Only fixed, non-identifying event context is accepted.
      ['event_category', 'event_label', 'method', 'source', 'stage', 'plan', 'geo_status'].forEach(function (field) {
        var value = params && params[field];
        if (typeof value === 'string' && /^[a-z0-9_ -]{1,40}$/i.test(value)) safe[field] = value;
      });
      // Preserve first-touch campaign context without replacing native GA attribution.
      var attribution = typeof rookGetStoredAttribution === 'function' ? rookGetStoredAttribution() : {};
      ['source', 'medium', 'campaign', 'content', 'term'].forEach(function (field) {
        var value = attribution['utm_' + field];
        if (typeof value === 'string' && !/@|https?:\/\//i.test(value)) safe['first_touch_' + field] = value.slice(0, 100);
      });
      if (typeof window.gtag === 'function') window.gtag('event', name, safe);
      var resourceSlug = sessionStorage.getItem('rook_resource_origin');
      if (resourceSlug && /^[a-z0-9-]{1,110}$/.test(resourceSlug) && typeof window.gtag === 'function') {
        if (name === 'v7_signup_started') window.gtag('event','resource_signup_start',{resource_slug:resourceSlug});
      }
      // Never forward account IDs, UTMs, or form values to Meta. Purchase may
      // include only plan value/currency for ROAS.
      if (mapping) {
        if (mapping[1] === 'Purchase') {
          var amount = planValues[params && params.plan];
          var payload = { currency: 'USD' };
          if (typeof amount === 'number') payload.value = amount;
          window.fbq(mapping[0], pixel, 'Purchase', payload);
        } else {
          window.fbq(mapping[0], pixel, mapping[1]);
        }
      }
    } catch (_) { /* Tracking must never interrupt the funnel. */ }
  };
})();
