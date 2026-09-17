const {normalizeSelection} = require('../public/rook-job-classification');
// Broad database prefilter only: every positive classifier pattern contains
// one of these fixed fragments. False positives are removed by the shared
// classifier before the scoring cap; experience backgrounds are never queried.
const fragments = {
  Diagnostics:['diagnostic','laborator','point','pathology','genetic','molecular','cancer','nipt'],
  'Medical Device':['medical','capital','surgical','dme','imaging','patient','consumable'],
  Pharmaceutical:['pharm','drug','medication','vaccine','therapeut','therap'],
  Veterinary:['vet','animal'],
  'Capital Equipment':['capital'], 'Healthcare SaaS':['healthcare','ehr','epd','clinical'],
  Dental:['dental'], Distribution:['distribution'], 'Biotech/Life Sciences':['biotech','life'],
};
function industryPrefilter(selection) {
  const selected=normalizeSelection(selection);
  const productTerms=[...new Set(selected.flatMap(label=>fragments[label]))];
  const clauses=['product_categories','market_industries'].flatMap(field=>productTerms.map(term=>`ai_analysis->>${field}.ilike.%${term}%`));
  if(selected.includes('Veterinary')) clauses.push(...fragments.Veterinary.map(term=>`ai_analysis->>required_customer_types.ilike.%${term}%`));
  return clauses.join(',');
}
module.exports={industryPrefilter};
