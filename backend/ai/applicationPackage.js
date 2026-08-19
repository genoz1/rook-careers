// AI-based application package generation — the tailored résumé summary,
// cover letter, recruiter outreach message, and interview prep notes
// shown on rook-application-package.html.
//
// This is meaningfully different from résumé/job analysis (which only
// EXTRACT structured data): this GENERATES new text that could be sent
// to a real employer, so the accuracy bar is higher. The system prompt
// is explicit and repeated: never invent employers, titles, dates, or
// achievements not present in the actual résumé text.
//
// Unlike résumé/job analysis (cached — run once, ever, per job/résumé),
// this is NOT cached or persisted anywhere. It regenerates on every page
// visit, which means a real API call (and real cost) each time someone
// opens the Application Package page for a given job. That's a
// deliberate scope simplification for this first pass, not an oversight
// — caching would need a new table or column to store the generated
// package per candidate+job, which didn't seem worth the schema
// migration until this feature has seen real use.

const { callClaudeForJSON } = require("./client");

const SYSTEM_PROMPT = `You are helping a candidate prepare a job application package for a specific medical/veterinary sales job posting, based ONLY on their actual résumé text. This is for a real job application that may be sent to a real employer — accuracy is critical.

CRITICAL RULE: Never invent employers, job titles, dates, achievements, numbers, or any experience not explicitly present in the provided résumé text. You may reorganize, reword, emphasize, and reorder existing content to better align with the job posting's language — but every fact must trace back to something actually stated in the résumé. If the résumé doesn't support a claim the job posting would want, do not manufacture one.

Return ONLY a JSON object with this exact shape, no other text:
{
  "tailored_summary": string,
  "tailored_bullets": [string],
  "ats_keywords": [string],
  "cover_letter": string,
  "recruiter_message": string,
  "interview_prep_notes": [{"question": string, "how_to_answer": string}]
}

Guidance for each field:
- tailored_summary: 2-3 sentences, reworded from the résumé to emphasize what matches this specific job.
- tailored_bullets: 3-6 achievement bullets pulled from the résumé, reworded/reordered to lead with what's most relevant to this job. Do not add bullets for things not in the résumé.
- ats_keywords: keywords from the job posting that the candidate's real experience genuinely supports — not every keyword in the posting, only ones truthfully backed by their background.
- cover_letter: 3-4 short paragraphs, specific to this exact role and company, grounded in real résumé content.
- recruiter_message: 3-5 sentences, a brief LinkedIn/email outreach note.
- interview_prep_notes: 4-6 likely interview questions for this specific role, each with a short note on how the candidate's real background answers it.`;

/**
 * Generate a tailored application package for one candidate/job pair.
 * @param {string} resumeText - the candidate's extracted résumé text
 * @param {string} jobTitle
 * @param {string} companyName
 * @param {string} jobDescription
 * @returns {Promise<object>} the package (see SYSTEM_PROMPT shape)
 */
async function generateApplicationPackage(resumeText, jobTitle, companyName, jobDescription) {
  if (!resumeText || resumeText.trim().length < 50) {
    throw new Error("Résumé text is too short or missing — upload a résumé first");
  }
  const truncatedResume = resumeText.slice(0, 12000);
  const truncatedJob = (jobDescription || "").slice(0, 8000);
  const userPrompt = `Candidate's résumé:\n\n${truncatedResume}\n\n---\n\nJob posting:\nTitle: ${jobTitle || "Unknown"}\nCompany: ${companyName || "Unknown"}\nDescription: ${truncatedJob}`;
  return callClaudeForJSON(SYSTEM_PROMPT, userPrompt, 3500);
}

module.exports = { generateApplicationPackage };
