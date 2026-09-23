// Existing resume_structured contract; no new profile/database fields.
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const years = { type: ['number', 'null'], minimum: 0 };
const strings = { type: 'array', items: string };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const RESUME_SCHEMA = object({
  industries_experience: { type: 'array', items: object({ industry: string, years_estimate: years }) },
  product_categories: strings, customer_types: strings, sales_motion: strings,
  seniority_level: nullableString, total_sales_years: years,
  management_experience: { type: 'boolean' }, clinical_technical_experience: strings,
  specialties: strings, certifications: strings, performance_highlights: strings,
  employers: { type: 'array', items: object({ company: string, title: string, start: nullableString, end: nullableString, achievements: nullableString }) },
});
module.exports = { RESUME_SCHEMA };
