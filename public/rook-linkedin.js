// Existing ROOK Insight Tag account, also installed on the member dashboard.
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
