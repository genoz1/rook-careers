// One market/product classification for browser filters and server queries.
// Candidate experience requirements are deliberately not job-market evidence.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RookJobClassification = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 1;
  const patterns = {
    Diagnostics: /\b(diagnostics?|reference laborator(?:y|ies)|point[ -]of[ -]care|clinical laborator(?:y|ies)|pathology|genetic testing|molecular testing|cancer screening|nipt)\b/i,
    'Medical Device': /\b(medical devices?|capital equipment|surgical|dme|imaging equipment|imaging guided therapy|patient monitoring|consumables)\b/i,
    Pharmaceutical: /\b(pharmaceuticals?|pharma|drugs?|medications?|vaccines?|therapeutics?|therapies)\b/i,
    Veterinary: /\b(veterinary|veterinarian(?:s)?|vet(?:s)?|animal health)\b/i,
    'Capital Equipment': /\bcapital equipment\b/i,
    'Healthcare SaaS': /\b(healthcare saas|ehr|epd|clinical information systems?)\b/i,
    Dental: /\bdental\b/i,
    Distribution: /\bdistribution\b/i,
    'Biotech/Life Sciences': /\b(biotech|life sciences?)\b/i,
  };
  function values(value) { return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []; }
  function classify(job) {
    const ai = job && job.ai_analysis;
    if (!ai || typeof ai !== 'object') {
      const cached = job?.industry_classification;
      const labels = cached?.version === VERSION ? values(cached.labels).filter(label => Object.hasOwn(patterns, label)) : [];
      return { version: VERSION, labels, status: labels.length ? 'classified' : 'unresolved' };
    }
    const products = [...values(ai.product_categories), ...values(ai.market_industries)];
    const customers = values(ai.required_customer_types);
    const labels = Object.keys(patterns).filter(label =>
      products.some(v => patterns[label].test(v)) ||
      (label === 'Veterinary' && customers.some(v => patterns.Veterinary.test(v)))
    );
    return { version: VERSION, labels, status: labels.length ? 'classified' : 'unresolved' };
  }
  const aliases = { 'animal health': 'Veterinary', 'veterinary/animal health': 'Veterinary', 'diagnostics & laboratory': 'Diagnostics', 'diagnostics/laboratory': 'Diagnostics' };
  function normalizeSelection(selection) {
    return [...new Set(values(selection).map(value => {
      const key = value.trim().toLowerCase();
      return aliases[key] || Object.keys(patterns).find(label => label.toLowerCase() === key) || null;
    }).filter(Boolean))];
  }
  function matches(job, selection) {
    const selected = normalizeSelection(selection);
    if (!selected.length) return false;
    return classify(job).labels.some(label => selected.includes(label));
  }
  return { VERSION, classify, normalizeSelection, matches };
});
