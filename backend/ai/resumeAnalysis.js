// AI-based résumé analysis — turns extracted résumé text into the
// structured data the matching engine needs (industry experience,
// product categories sold, customer/call-point types, sales motion,
// seniority, years of experience, clinical/technical background).
//
// This is genuinely new inference the platform couldn't do before —
// previously only self-reported onboarding chips existed. Claude never
// invents employers, titles, or achievements not present in the résumé
// text — the system prompt explicitly instructs against fabrication,
// consistent with the same "never invent experience" principle used for
// résumé tailoring elsewhere in the architecture spec.

const { callClaudeForJSON } = require("./client");

const SYSTEM_PROMPT = `You are analyzing a résumé for a medical and veterinary sales job-matching platform. Extract ONLY information that is actually present in the résumé text — never invent employers, titles, dates, or achievements that aren't there. If something isn't mentioned, use an empty array or null rather than guessing.

Return ONLY a JSON object with this exact shape, no other text:
{
  "industries_experience": [{"industry": string, "years_estimate": number|null}],
  "product_categories": [string],
  "customer_types": [string],
  "sales_motion": [string],
  "seniority_level": string|null,
  "total_sales_years": number|null,
  "management_experience": boolean,
  "clinical_technical_experience": [string],
  "specialties": [string],
  "certifications": [string],
  "performance_highlights": [string],
  "employers": [{"company": string, "title": string, "start": string|null, "end": string|null, "achievements": string|null}]
}

For each entry in "employers", "achievements" should contain the bullet points, responsibilities, or accomplishments listed specifically under THAT role in the résumé — as they actually appear, one per line, not summarized or rewritten. Only include what the résumé actually states for that specific job; never invent an achievement, and never move or copy a bullet from one job into another employer's entry. If a role has no bullets/accomplishments listed at all, use null for that employer's "achievements" rather than leaving it out of the object.

Use these controlled vocabularies where the résumé content matches them, in addition to anything else genuinely present:
- industries: Medical Device, Diagnostics, Reference Laboratory, Point-of-Care Diagnostics, Pharmaceutical, Biotech/Life Sciences, Veterinary/Animal Health, Dental, Healthcare SaaS, Distribution, Capital Equipment, Consumables
- sales_motion: Hunter, Account Management, Territory Development, Strategic/Key Accounts, Channel/Distributor Sales, Direct Sales, Inside Sales, Outside Sales, Enterprise Sales, Consultative Sales
- seniority_level: Entry Level, Associate Rep, Territory Representative, Account Executive, Territory Manager, Key Account Manager, Regional Manager, Director, VP`;

/**
 * Analyze résumé text and return structured data for matching.
 * @param {string} resumeText - extracted plain text from the résumé
 * @param {object} [deps] - injectable dependencies for testing; defaults
 *   to the real Claude client. Never used by the one real caller
 *   (backend/routes/profile.js), which relies on the default.
 * @returns {Promise<object>} structured résumé data (see SYSTEM_PROMPT shape)
 */
async function analyzeResume(resumeText, { callAI = callClaudeForJSON } = {}) {
  if (!resumeText || resumeText.trim().length < 50) {
    throw new Error("Résumé text is too short or empty to analyze");
  }
  // Truncate extremely long résumés to keep the request reasonable —
  // most résumés are 1-3 pages; this generously allows for longer ones.
  const truncated = resumeText.slice(0, 15000);
  // 4000 tokens, not the default 2500 — a résumé with several employers
  // (each with title, dates, and a handful of achievement bullets) plus
  // all the other structured fields in this shape routinely runs past
  // 2500 tokens of JSON output. At 2500, Claude's response was getting
  // cut off mid-string on exactly this kind of résumé, producing
  // truncated JSON that failed to parse — logged as "Resume AI analysis
  // failed" and shown to the candidate as "we couldn't automatically
  // read your work history," even though extraction and analysis were
  // both actually working right up until the token limit cut them off.
  return callAI(SYSTEM_PROMPT, `Résumé text:\n\n${truncated}`, 4000);
}

module.exports = { analyzeResume, SYSTEM_PROMPT };
