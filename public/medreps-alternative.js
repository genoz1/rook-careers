(function () {
  'use strict';
  try { sessionStorage.setItem('rook_acquisition_origin', 'medreps-alternative'); } catch (_) {}
  function track(name, params) {
    try { if (typeof gtag === 'function') gtag('event', name, {acquisition_page:'medreps-alternative', ...params}); } catch (_) {}
  }
  track('medreps_alternative_view');
  var current = new URLSearchParams(location.search);
  document.querySelectorAll('[data-cta]').forEach(function (link) {
    var destination = new URL(link.getAttribute('href'), location.origin);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','gbraid','wbraid','fbclid'].forEach(function (key) {
      if (current.has(key)) destination.searchParams.set(key, current.get(key));
    });
    link.href = destination.pathname + destination.search;
    link.addEventListener('click', function () { track('medreps_alternative_cta_click', {cta_location:link.dataset.cta}); });
  });
  // Trial length is controlled by the live billing configuration; omit the offer if unavailable.
  fetch('/api/stripe/trial-config', {cache:'no-store'}).then(function (response) {
    if (!response.ok) throw Error('Trial configuration unavailable');
    return response.json();
  }).then(function (config) {
    if (Number.isInteger(config.trialDays) && config.trialDays > 0) {
      var offer = document.getElementById('trialOffer');
      offer.textContent = 'Try ROOK free for ' + config.trialDays + ' ' + (config.trialDays === 1 ? 'day' : 'days') + '.';
      offer.hidden = false;
    }
  }).catch(function () {});
})();
