/* Curated, locally hosted V8 employer assets. Keys match the supplied company_name manifest. */
window.RookV8EmployerLogo = (() => {
  const assets = Object.freeze({
    'abbott': 'abbott.svg',
    'medtronic': 'medtronic.svg',
    'stryker': 'stryker.svg',
    'abbvie': 'abbvie.svg',
    'johnson & johnson': 'johnson-and-johnson.svg',
    'philips': 'philips.webp',
    'ge healthcare': 'ge-healthcare.svg',
    'iqvia': 'iqvia.svg',
    'viatris': 'viatris.svg',
    'bd (becton, dickinson and company)': 'bd.svg',
    'novartis': 'novartis.svg',
    'smith+nephew': 'smith-nephew.svg',
    'fresenius medical care': 'fresenius-medical-care.svg',
    'baxter': 'baxter.svg',
    'regeneron': 'regeneron.svg',
    'medical sales college': 'medical-sales-college.png',
    'astrazeneca': 'astrazeneca.svg',
    'edwards lifesciences': 'edwards-lifesciences.svg',
    'intuitive surgical': 'intuitive-surgical.svg',
    'amgen': 'amgen.svg',
    'boston scientific': 'boston-scientific.svg'
  });
  const key = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  function render(name) {
    const initial = (String(name || '').match(/[A-Za-z0-9]/) || ['R'])[0].toUpperCase();
    const filename = assets[key(name)];
    return `<span class="v8-employer-logo" aria-hidden="true">${initial}${filename
      ? `<img src="assets/employer-logos/${filename}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
      : ''}</span>`;
  }
  return Object.freeze({ render });
})();
