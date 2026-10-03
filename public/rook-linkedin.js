// Existing ROOK Insight Tag account, also installed on the member dashboard.
(function () {
  if (window.rookLinkedInV9Track) return;
  // Real event-specific conversion IDs from ROOK Campaign Manager.
  // Paid subscriptions are server-confirmed and intentionally excluded here.
  var conversions = {v9_landing:31096634,v9_email_verified:31096642,v9_checkout_started:31096650};
  var seen = Object.create(null);
  window.rookLinkedInV9Track = function (name) {
    try {
      if (!Object.prototype.hasOwnProperty.call(conversions,name) || seen[name] || typeof window.lintrk !== 'function') return;
      window.lintrk('track',{conversion_id:conversions[name]});
      seen[name] = true;
    } catch (_) {}
  };
})();
(function () {
  var id = '9629410';
  var ids = window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
  if (ids.indexOf(id) !== -1) return;
  ids.push(id);
  if (!window.lintrk) {
    window.lintrk = function(a,b) { window.lintrk.q.push([a,b]); };
    window.lintrk.q = [];
  }
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';
  document.head.appendChild(script);
})();
