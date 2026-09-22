const { titleHasStrongSalesSignal } = require('./relevanceFilter');

const CANONICAL_INDUSTRIES = [
  'Diagnostics', 'Medical Device', 'Pharmaceutical', 'Veterinary',
  'Capital Equipment', 'Healthcare SaaS', 'Dental', 'Distribution',
  'Biotech/Life Sciences',
];

const INDUSTRY_PATTERNS = {
  Diagnostics: /\b(diagnostics?|laborator(?:y|ies)|point[ -]of[ -]care(?: testing| diagnostics?)?|pathology|genetic testing|molecular testing|cancer screening|nipt)\b/i,
  'Medical Device': /\b(medical devices?|surgical devices?|surgical systems?|patient monitoring(?: systems?)?|dme|durable medical equipment|imaging equipment|imaging guided therapy|medical consumables?)\b/i,
  Pharmaceutical: /\b(pharmaceuticals?|pharma(?:ceutical)? products?|prescription drugs?|medications?|vaccines?|therapeutics?|drug therapies|specialty pharma)\b/i,
  Veterinary: /\b(veterinary|veterinarian(?:s)?|animal health|vet(?:erinary)? clinics?)\b/i,
  'Capital Equipment': /\bcapital equipment\b/i,
  'Healthcare SaaS': /\b(healthcare saas|health(?:care)? software|clinical software|ehr(?: software| platform| systems?)?|electronic health records?|clinical information systems?)\b/i,
  Dental: /\b(dental|dentists?|orthodontic)\b/i,
  Distribution: /\b(healthcare distribution|medical distribution|pharmaceutical distribution|distribution services?)\b/i,
  'Biotech/Life Sciences': /\b(biotech(?:nology)?|life sciences?)\b/i,
};

const BACKGROUND_ONLY = /\b(experience|background|preferred qualifications?|minimum qualifications?|knowledge|familiarity|exposure|candidate|applicant|years? (?:of|in)|equal opportunity|without regard)\b/i;
const MARKET_ACTION = /\b(sell(?:s|ing)?|sales|commerciali[sz](?:e|es|ing|ation)|promot(?:e|es|ing)|market(?:s|ing)?|portfolio|product(?:s)?|solution(?:s)?|platform(?:s)?|offering(?:s)?|business unit|franchise|therapy area)\b/i;

function labelsFromText(text) {
  return CANONICAL_INDUSTRIES.filter(label => INDUSTRY_PATTERNS[label].test(String(text || '')));
}

function labelsFromEmployerIndustry(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[_-]+/g, ' ').replace(/[\/]+/g, ' ').replace(/\s+/g, ' ');
  if (!normalized) return [];
  const exact = {
    diagnostics: ['Diagnostics'], 'diagnostics laboratory': ['Diagnostics'], 'diagnostics and laboratory': ['Diagnostics'],
    'medical device': ['Medical Device'], 'medical devices': ['Medical Device'],
    pharmaceutical: ['Pharmaceutical'], pharmaceuticals: ['Pharmaceutical'], pharma: ['Pharmaceutical'],
    veterinary: ['Veterinary'], 'animal health': ['Veterinary'], 'veterinary animal health': ['Veterinary'],
    'capital equipment': ['Capital Equipment'], 'healthcare saas': ['Healthcare SaaS'],
    dental: ['Dental'], distribution: ['Distribution'], biotech: ['Biotech/Life Sciences'],
    'life sciences': ['Biotech/Life Sciences'], 'biotech life sciences': ['Biotech/Life Sciences'],
    'veterinary diagnostics': ['Veterinary', 'Diagnostics'],
    'animal health diagnostics': ['Veterinary', 'Diagnostics'],
    'veterinary pharmaceutical': ['Veterinary', 'Pharmaceutical'],
    'animal health pharmaceutical': ['Veterinary', 'Pharmaceutical'],
    'medical device capital equipment': ['Medical Device', 'Capital Equipment'],
  };
  return exact[normalized] || [];
}

function deterministicIndustryEvidence({ title = '', description = '', employerIndustry = '' } = {}) {
  const labels = new Set(labelsFromText(title));
  const lines = String(description || '').split(/(?:\r?\n|(?<=[.!?])\s+)/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const direct = labelsFromText(line);
    if (!direct.length) continue;
    if (BACKGROUND_ONLY.test(line)) continue;
    if (MARKET_ACTION.test(line)) direct.forEach(label => labels.add(label));
  }
  if (!labels.size) labelsFromEmployerIndustry(employerIndustry).forEach(label => labels.add(label));

  const customerLines = lines.filter(line => /\b(call(?:s|ing)? on|sell(?:s|ing)? to|serv(?:e|es|ing)|customers? include)\b/i.test(line));
  const veterinaryCustomers = customerLines.some(line => /\b(veterinarians?|veterinary clinics?|animal hospitals?)\b/i.test(line));
  return { labels: [...labels], required_customer_types: veterinaryCustomers ? ['Veterinary professionals'] : [] };
}

// Conservative, source-independent enrichment. Industry evidence comes only
// from explicit role/product language or exact configured employer metadata;
// the employer's company name is never inspected.
function deterministicJobAnalysis(input = '', descriptionArg = '', employerIndustryArg = '') {
  const options = typeof input === 'object' && input !== null
    ? input
    : { title: input, description: descriptionArg, employerIndustry: employerIndustryArg };
  const title = String(options.title || '');
  const strongSales = titleHasStrongSalesSignal(title);
  const evidence = deterministicIndustryEvidence(options);
  if (!strongSales) return null;
  const t = title.toLowerCase();
  let seniority_level = null;
  if (/associate territory (?:sales )?representative/.test(t)) seniority_level = 'Associate Rep';
  else if (/territory (?:sales )?representative/.test(t)) seniority_level = 'Territory Representative';
  else if (/key account manager/.test(t)) seniority_level = 'Key Account Manager';
  else if (/territory manager|territory sales manager/.test(t)) seniority_level = 'Territory Manager';
  else if (/regional sales manager|district manager/.test(t)) seniority_level = 'Regional Manager';
  else if (/account executive/.test(t)) seniority_level = 'Account Executive';

  return {
    required_industries: [], preferred_industries: [], required_years_experience: null,
    required_customer_types: evidence.required_customer_types,
    clinical_requirements: [], specialty_requirements: [], seniority_level,
    sales_motion: strongSales ? ['sales'] : [],
    product_categories: evidence.labels, market_industries: evidence.labels,
    hard_requirements: [], preferred_requirements: [], analysis_source: 'deterministic_evidence',
  };
}

module.exports = { CANONICAL_INDUSTRIES, deterministicIndustryEvidence, deterministicJobAnalysis, labelsFromEmployerIndustry };
