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
  var offer = document.getElementById('trialOffer');
  if (offer) {
    offer.textContent = 'Preview current protected matches first. Paid access starts at $5.99.';
    offer.hidden = false;
  }
})();
