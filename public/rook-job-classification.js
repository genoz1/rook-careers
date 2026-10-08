// One market/product classification for browser filters and server queries.
// Candidate experience requirements are deliberately not job-market evidence.
//
// AI product_categories are useful but not authoritative. Title, company name,
// and description text can override a conflicting AI label (e.g. Trauma device
// role mis-tagged as Pharmaceutical).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RookJobClassification = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 2;
  const patterns = {
    Diagnostics: /\b(diagnostics?|reference laborator(?:y|ies)|point[ -]of[ -]care|clinical laborator(?:y|ies)|pathology|genetic testing|molecular testing|cancer screening|nipt|labcorp|quest diagnostics|hologic|cepheid|bio[ -]?rad)\b/i,
    'Medical Device': /\b(medical devices?|capital equipment|surgical|orthop(?:a)?edic|trauma(?:\s+and\s+reconstruction)?|dme|imaging equipment|imaging guided therapy|patient monitoring|consumables|stryker|medtronic|boston scientific|zimmer|smith\s*(?:\+|and|&)?\s*nephew|arthrex|intuitive surgical)\b/i,
    // Keep product/market language only — commercial titles like
    // "Oncology Account Specialist" appear in both pharma and diagnostics
    // screening and must not force a Pharmaceutical label from title text.
    Pharmaceutical: /\b(pharmaceuticals?|pharma(?!\s*cist)|drugs?|medications?|vaccines?|therapeutics?|therapies|specialty pharmacy)\b/i,
    Veterinary: /\b(veterinary|veterinarian(?:s)?|vet(?:s)?|animal health|zoetis|elanco|idexx|covetrus|hill'?s pet)\b/i,
    'Capital Equipment': /\bcapital equipment\b/i,
    'Healthcare SaaS': /\b(healthcare saas|ehr|epd|clinical information systems?)\b/i,
    Dental: /\bdental\b/i,
    Distribution: /\bdistribution\b/i,
    'Biotech/Life Sciences': /\b(biotech|life sciences?)\b/i,
  };

  // Markets that commonly get confused by AI — when text evidence strongly
  // supports one and AI asserts another exclusive label, prefer text.
  const CONFLICT_GROUPS = [
    ['Medical Device', 'Pharmaceutical'],
    ['Diagnostics', 'Pharmaceutical'],
    ['Veterinary', 'Pharmaceutical'],
    ['Medical Device', 'Diagnostics'],
  ];

  function values(value) { return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []; }

  function evidenceText(job) {
    if (!job || typeof job !== 'object') return '';
    return [
      job.title_original,
      job.title_normalized,
      job.company_name,
      // Prefer a short description window — full HTML is noisy and expensive.
      String(job.description_text || '').slice(0, 2500),
    ].filter(Boolean).join('\n');
  }

  function labelsFromText(text) {
    if (!text) return [];
    return Object.keys(patterns).filter(label => patterns[label].test(text));
  }

  function labelsFromAi(ai) {
    if (!ai || typeof ai !== 'object') return [];
    const products = [...values(ai.product_categories), ...values(ai.market_industries)];
    const customers = values(ai.required_customer_types);
    return Object.keys(patterns).filter(label =>
      products.some(v => patterns[label].test(v)) ||
      (label === 'Veterinary' && customers.some(v => patterns.Veterinary.test(v)))
    );
  }

  function reconcileLabels(textLabels, aiLabels) {
    if (!textLabels.length) return aiLabels;
    if (!aiLabels.length) return textLabels;
    let result = [...new Set([...textLabels, ...aiLabels])];
    for (const [a, b] of CONFLICT_GROUPS) {
      const textHasA = textLabels.includes(a);
      const textHasB = textLabels.includes(b);
      const aiHasA = aiLabels.includes(a);
      const aiHasB = aiLabels.includes(b);
      // Text supports A but not B, AI claims B (possibly without A) → drop B.
      if (textHasA && !textHasB && aiHasB && !textLabels.includes(b)) {
        result = result.filter(label => label !== b);
        if (!result.includes(a)) result.push(a);
      }
      if (textHasB && !textHasA && aiHasA && !textLabels.includes(a)) {
        result = result.filter(label => label !== a);
        if (!result.includes(b)) result.push(b);
      }
    }
    return result;
  }

  function classify(job) {
    const textLabels = labelsFromText(evidenceText(job));
    const ai = job && job.ai_analysis;
    if (!ai || typeof ai !== 'object') {
      const cached = job?.industry_classification;
      const cachedLabels = cached?.version === VERSION ? values(cached.labels).filter(label => Object.hasOwn(patterns, label)) : [];
      const labels = reconcileLabels(textLabels, cachedLabels);
      return { version: VERSION, labels, status: labels.length ? 'classified' : 'unresolved', source: textLabels.length ? 'text' : 'cached' };
    }
    const aiLabels = labelsFromAi(ai);
    const labels = reconcileLabels(textLabels, aiLabels);
    return {
      version: VERSION,
      labels,
      status: labels.length ? 'classified' : 'unresolved',
      source: textLabels.length && JSON.stringify(textLabels) !== JSON.stringify(aiLabels) ? 'reconciled' : 'ai',
    };
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
  return { VERSION, classify, normalizeSelection, matches, labelsFromText, reconcileLabels };
});
