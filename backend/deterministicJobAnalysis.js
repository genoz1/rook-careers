const { titleHasStrongSalesSignal } = require('./relevanceFilter');

// Minimal, source-independent enrichment for titles that unambiguously name a
// selling role. It deliberately does not guess product, market, customers, or
// experience requirements from an employer name or description. Those fields
// remain empty until ROOK has trustworthy structured evidence.
function deterministicJobAnalysis(title = '') {
  if (!titleHasStrongSalesSignal(title)) return null;
  const t = String(title).toLowerCase();
  let seniority_level = null;
  if (/associate territory (?:sales )?representative/.test(t)) seniority_level = 'Associate Rep';
  else if (/territory (?:sales )?representative/.test(t)) seniority_level = 'Territory Representative';
  else if (/key account manager/.test(t)) seniority_level = 'Key Account Manager';
  else if (/territory manager|territory sales manager/.test(t)) seniority_level = 'Territory Manager';
  else if (/regional sales manager|district manager/.test(t)) seniority_level = 'Regional Manager';
  else if (/account executive/.test(t)) seniority_level = 'Account Executive';

  return {
    required_industries: [], preferred_industries: [], required_years_experience: null,
    required_customer_types: [], clinical_requirements: [], specialty_requirements: [],
    seniority_level, sales_motion: ['sales'], product_categories: [], market_industries: [],
    hard_requirements: [], preferred_requirements: [], analysis_source: 'deterministic_title',
  };
}

module.exports = { deterministicJobAnalysis };
