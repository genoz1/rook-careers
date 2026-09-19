const { maskedTitle, freshness } = require('./maskedPresentation');
// Server-side redaction logic for free/non-subscribed candidates and
// anonymous visitors — the actual enforcement mechanism behind the free
// dashboard's "employer name, full description, source/application URL,
// and recruiter contact info are never sent to the client" rule. Pulled
// out of routes/jobs.js into its own file specifically so it's directly unit-testable (see
// testTrialFlow.js) without requiring jobs.js itself, which pulls in
// email/geocoding/scoring modules that expect real env vars/network
// access to construct safely.

// Escapes regex special characters in a company name before using it in
// a pattern — company names can contain characters like "." or "+"
// (e.g. "3M", "C.R. Bard") that would otherwise be interpreted as regex
// syntax instead of literal text.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces every occurrence of the employer's name in a block of text
// with a neutral placeholder. Real bug this fixes: company_name was
// being stripped from the job OBJECT for non-subscribers, but the raw
// description_text almost always names the employer in its own opening
// sentence ("Medtronic is a global leader in...") — completely
// defeating the redaction, since the name was sitting in plain sight a
// few lines below the "Employer hidden" badge. This catches the base
// name regardless of legal-suffix variations ("Medtronic Inc.",
// "Medtronic Corporation") since those still contain the base name as
// a substring.
// Common legal-entity suffixes that are never worth scrubbing on their
// own — "Inc" or "LLC" alone doesn't identify who the employer is, and
// treating them as significant words would create a lot of pointless
// replacements throughout ordinary text.
const COMPANY_SUFFIX_WORDS = new Set([
  "inc", "inc.", "llc", "llc.", "corp", "corp.", "corporation", "co", "co.",
  "company", "ltd", "ltd.", "limited", "group", "holdings", "the", "of",
]);

function scrubCompanyNameFromText(text, companyName) {
  if (!text || !companyName) return text;
  let result = text.replace(new RegExp(escapeRegex(companyName), "gi"), "this employer");

  // Real gap this closes: matching only the exact full stored
  // company_name misses the very common case where a job posting's own
  // description text refers to the employer by a shorter form of its
  // name than what's stored in the database — e.g. company_name is
  // "Caris Life Sciences" but the posting's own text says "At Caris,
  // we understand..." Reported directly: the listing page still showed
  // "At Caris" in a preview even after the exact-match scrub was
  // working correctly on the job detail page. Scrubbing each
  // significant standalone word from the company name too (skipping
  // short/common legal-suffix words) catches this without needing to
  // guess every possible abbreviated form in advance.
  //
  // Reported directly, a second gap: a company known by a short
  // all-caps acronym/brand (e.g. "MWI", for MWI Animal Health) leaked
  // straight through in a job TITLE ("Regional Manager - MWI") even
  // after this fix, because "MWI" is only 3 characters and the
  // length-based filter below exists specifically to skip short,
  // common, non-identifying words (like "of" or "co") — it wasn't
  // meant to also exclude a genuinely identifying short acronym. An
  // all-caps token is treated as identifying regardless of length,
  // since ordinary English words this short are essentially never
  // fully capitalized in normal text.
  const words = companyName.split(/\s+/).filter((w) => {
    const letters = w.replace(/[^a-zA-Z]/g, "");
    if (COMPANY_SUFFIX_WORDS.has(w.toLowerCase())) return false;
    if (letters.length > 3) return true;
    return letters.length >= 2 && letters === letters.toUpperCase();
  });
  for (const word of words) {
    result = result.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, "gi"), "this employer");
  }
  return result;
}

function redactForNonSubscriber(job) {
  const {
    company_name, source_url, application_url, location_evidence, extraction_evidence,
    recruiter_name, recruiter_email, recruiter_company, recruiter_contact_method, // same gate applies to recruiter postings
    description_text, description_preview,
    title_original, title_normalized,
    ...rest
  } = job;
  const scrubbedFullText = scrubCompanyNameFromText(description_text, company_name);
  return {
    ...rest,
    territory_locations: require('../public/rook-territory-location').territories(job),
    // Locked titles use the shared role/specialty vocabulary and territory rules.
    // Original job objects and subscriber responses are never modified.
    title_original: maskedTitle(job, title_original || title_normalized),
    title_normalized: title_normalized ? maskedTitle(job, title_normalized) : null,
    freshness_label: freshness(job),
    description_text: scrubbedFullText,
    description_preview: scrubCompanyNameFromText(description_preview, company_name) ?? (scrubbedFullText ? scrubbedFullText.slice(0, 300) : undefined),
    subscription_required: true,
  };
}

// Stricter than redactForNonSubscriber: an anonymous visitor has no
// account at all, so on top of the usual company/apply-link redaction,
// this also strips the match score, recommendation, categories,
// reasons, and concerns entirely. Direct instruction: "mask the job
// details so when the customer actually signs up its the same
// format" — same card layout and same real scoreJob()-driven ranking
// as a signed-in candidate would see, just with everything that would
// reveal the fit or the employer removed rather than shown for free.
function redactForAnonymous(job) {
  const withCompanyRedacted = redactForNonSubscriber(job);
  const { match, ...rest } = withCompanyRedacted;
  return rest;
}

module.exports = { escapeRegex, scrubCompanyNameFromText, redactForNonSubscriber, redactForAnonymous };
