// AI-based role title suggestions — replaces the earlier naive
// "seniority + industry" string concatenation (e.g. "Territory Manager
// — Diagnostics") with real, specific job titles a candidate would
// actually search for or see in postings, informed by their full résumé
// analysis rather than just two fields glued together.

const { callClaudeForJSON } = require("./client");

const SYSTEM_PROMPT = `You are suggesting realistic job titles for a medical/veterinary sales candidate to search for, based on their résumé analysis. Suggest titles that actually appear in real job postings in this field — not generic combinations, not invented titles that don't reflect how these roles are actually named in the industry.

Ground every suggestion in the candidate's actual industries, product categories, customer types, seniority level, and sales motion — don't suggest a title for an industry or seniority level they don't have.

Return ONLY a JSON object with this exact shape, no other text:
{
  "suggested_roles": [string]
}

Suggest exactly 6 titles, ordered from closest fit to more of a stretch/adjacent fit.`;

/**
 * Suggest realistic role titles from a candidate's résumé analysis.
 * @param {object} resumeStructured - the résumé analysis object (see backend/ai/resumeAnalysis.js)
 * @returns {Promise<string[]>} up to 6 suggested role titles
 */
async function suggestRoles(resumeStructured) {
  const summary = {
    industries: (resumeStructured.industries_experience || []).map((i) => i.industry),
    product_categories: resumeStructured.product_categories || [],
    customer_types: resumeStructured.customer_types || [],
    seniority_level: resumeStructured.seniority_level,
    sales_motion: resumeStructured.sales_motion || [],
    total_sales_years: resumeStructured.total_sales_years,
  };
  const result = await callClaudeForJSON(SYSTEM_PROMPT, `Candidate résumé summary:\n\n${JSON.stringify(summary, null, 2)}`, 500);
  return Array.isArray(result.suggested_roles) ? result.suggested_roles.slice(0, 6) : [];
}

module.exports = { suggestRoles };
