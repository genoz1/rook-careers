// AI-based job requirement analysis — turns a raw job posting into
// structured requirement data the matching engine can compare against a
// candidate's résumé analysis, including classifying each requirement's
// real strength (Mandatory vs Preferred vs Boilerplate) rather than
// treating every line of a posting as equally binding.

const { callClaudeForJSON } = require("./client");

const SYSTEM_PROMPT = `You are analyzing a medical/veterinary sales job posting for a job-matching platform. Extract ONLY what the posting actually states — never invent requirements that aren't there.

Return ONLY a JSON object with this exact shape, no other text:
{
  "required_industries": [string],
  "preferred_industries": [string],
  "required_years_experience": number|null,
  "required_customer_types": [string],
  "clinical_requirements": [{"requirement": string, "strength": "mandatory"|"preferred"|"boilerplate"}],
  "specialty_requirements": [string],
  "seniority_level": string|null,
  "sales_motion": [string],
  "product_categories": [string],
  "hard_requirements": [string],
  "preferred_requirements": [string]
}

Classify each requirement's real strength based on the actual language used:
- "mandatory": phrases like "must have", "required", "X+ years required"
- "preferred": phrases like "preferred", "a plus", "ideally"
- "boilerplate": generic phrases that appear in nearly every posting regardless of actual necessity (e.g. "excellent communication skills", "team player")

Keep every string value SHORT — a few words each, not full sentences. This keeps the whole response well within the token budget even for long, detailed postings.

Use these controlled vocabularies where the posting content matches them, in addition to anything else genuinely stated:
- industries: Medical Device, Diagnostics, Reference Laboratory, Point-of-Care Diagnostics, Pharmaceutical, Biotech/Life Sciences, Veterinary/Animal Health, Dental, Healthcare SaaS, Distribution, Capital Equipment, Consumables
- seniority_level: Entry Level, Associate Rep, Territory Representative, Account Executive, Territory Manager, Key Account Manager, Regional Manager, Director, VP`;

/**
 * Analyze a job posting and return structured requirement data.
 * @param {string} title - the job's title
 * @param {string} descriptionText - the job's plain-text description
 * @returns {Promise<object>} structured job requirement data (see SYSTEM_PROMPT shape)
 */
async function analyzeJob(title, descriptionText) {
  const text = `${title || ""}\n\n${descriptionText || ""}`.trim();
  if (text.length < 30) {
    throw new Error("Job title/description is too short to analyze");
  }
  const truncated = text.slice(0, 12000);
  // Explicit 3000-token budget, higher than the client's 2500 default —
  // job postings produced the most verbose responses in practice (long
  // clinical_requirements and customer_types arrays), and were the
  // source of every truncation failure seen in the first real ingestion
  // run at volume (65 employers, some postings very detailed).
  return callClaudeForJSON(SYSTEM_PROMPT, `Job posting:\n\n${truncated}`, 3000);
}

module.exports = { analyzeJob };
