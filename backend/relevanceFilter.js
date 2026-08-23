// Shared "does this job title look like a sales role" filter — used by
// every adapter (Workday, SmartRecruiters, ClinchTalent, Oracle HCM) and
// by ingest.js directly for the adapters that return unfiltered raw
// postings (Greenhouse, Lever, Ashby).
//
// This used to be copy-pasted separately into 5 different files, which
// is exactly how a real bug slipped through everywhere at once: the
// original logic was "has a generic role word (manager/specialist/
// representative/executive/consultant) AND a domain word (medical/
// clinical/diagnostic/etc.)" — which is loose enough to match plenty of
// real non-sales roles that share vocabulary with the sales roles this
// is supposed to find: "Diagnostics Technical Support Representative",
// "Principal Field Clinical Procedure Specialist", "Global KOL
// Management Manager, Global Medical Affairs" all matched despite none
// of them being sales roles. The EXCLUSION_SIGNALS list below is the
// fix — checked first, before anything else — but it's a manually
// curated list, not exhaustive; a genuinely new non-sales title pattern
// this doesn't already know about could still slip through.

const EXCLUSION_SIGNALS = [
  "technical support", "medical affairs", "clinical procedure", "field clinical",
  "regulatory affairs", "quality assurance", "quality control", "medical science liaison",
  "clinical research", "customer support", "medical writer", "biostatistic",
  "software engineer", "data analyst", "data scientist", "it support",
  "clinical trial", "pharmacovigilance", "manufacturing", "supply chain",
  "human resources", "finance", "accounting", "legal counsel", "compliance officer",
  "customer service", "help desk", "warehouse", "logistics", "procurement",
  "biomedical engineer", "lab technician", "research scientist", "r&d",
  // Sales-ADJACENT roles — these all contain "sales" (which would
  // otherwise auto-pass via STRONG_TITLE_SIGNALS below), but describe
  // training, supporting, or managing sales operations rather than an
  // actual quota-carrying field sales role. A real, reported case:
  // "Sales Training Manager" matched the old filter purely because it
  // contains the word "sales", despite being a training role, not a
  // selling role.
  "sales training", "sales enablement", "sales operations", "sales excellence",
  "sales compensation", "sales analytics", "sales systems", "sales strategy",
];

const STRONG_TITLE_SIGNALS = [
  "sales", "account executive", "account manager", "territory manager",
  "territory sales", "business development", "key account",
];
const ROLE_WORDS = ["representative", "specialist", "manager", "executive", "consultant"];
const DOMAIN_WORDS = [
  "sales", "territory", "account", "veterinary", "medical", "pharmaceutical", "diagnostic", "clinical",
];

function titleLooksRelevant(title = "") {
  const t = title.toLowerCase();
  if (EXCLUSION_SIGNALS.some((k) => t.includes(k))) return false;
  if (STRONG_TITLE_SIGNALS.some((k) => t.includes(k))) return true;
  const hasRoleWord = ROLE_WORDS.some((k) => t.includes(k));
  const hasDomainWord = DOMAIN_WORDS.some((k) => t.includes(k));
  return hasRoleWord && hasDomainWord;
}

module.exports = { titleLooksRelevant };
