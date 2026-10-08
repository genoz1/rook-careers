// Shared sales-admission gate used by every ATS adapter, ingest.js, and
// discovery validators. Industry vocabulary alone is NEVER enough.
//
// Permanent product rule:
//   Industry relevance decides which markets ROOK searches.
//   A job must independently qualify as a sales/commercial role before
//   entering customer-visible inventory.
//
// Historical bug: ROLE_WORDS ∩ DOMAIN_WORDS treated "veterinary"/"clinical"
// + "manager"/"specialist" as sales. That admitted BluePearl hospital jobs
// such as "Veterinary Specialist Internal Medicine". This file replaces that
// heuristic with positive sales evidence (title and optional description).

const EXCLUSION_SIGNALS = [
  "technical support", "medical affairs", "clinical procedure", "field clinical",
  "regulatory affairs", "quality assurance", "quality control", "medical science liaison",
  "clinical research", "customer support", "medical writer", "biostatistic",
  "software engineer", "data analyst", "data scientist", "it support",
  "clinical trial", "pharmacovigilance", "manufacturing", "supply chain",
  "human resources", "finance", "accounting", "legal counsel", "compliance officer",
  "accounts payable", "accounts receivable", "billing", "medical biller",
  "medical director", "clinical lab", "clinical data", "coding specialist",
  "patient support", "revenue cycle", "regulatory & clinical",
  "customer service", "client service", "help desk", "warehouse", "logistics", "procurement",
  "biomedical engineer", "lab technician", "research scientist", "r&d",
  // Sales-adjacent operations — contain "sales" but are not quota-carrying
  // field/commercial selling roles.
  "sales training", "sales enablement", "sales operations", "sales excellence",
  "sales compensation", "sales analytics", "sales systems", "sales strategy",
  "sales coordinator", "sales admin", "sales administrator", "sales support",
  "inside sales support",
];

// Clinical / hospital / care-delivery roles that share industry vocabulary
// with ROOK's markets but are not commercial selling positions.
const CLINICAL_CARE_EXCLUSIONS = [
  "veterinarian", "veterinary technician", "vet tech", "veterinary nurse",
  "veterinary assistant", "veterinary specialist", "veterinary intern",
  "veterinary resident", "associate veterinarian", "emergency veterinarian",
  "veterinary clinical", "veterinary practice manager", "veterinary hospital",
  "veterinary client", "hospital manager", "practice manager",
  "veterinary relationship manager", "veterinary project manager",
  "veterinary clinic specialist", "veterinary dermatology",
  "internal medicine", "soft tissue surgeon", "surgeon", "surgery specialist",
  "critical care", "emergency clinician", "staff veterinarian",
  "physician", "registered nurse", "nurse practitioner", "physician assistant",
  "clinical nurse", "laboratory technician", "lab tech", "histotechn",
  "pathologist", "radiologist", "anesthesiologist", "pharmacist",
  "scientist", "research associate", "postdoctoral", "post-doc",
  "manufacturing technician", "production technician", "warehouse associate",
  "human resources", "talent acquisition", "recruiter",
  "software developer", "devops", "system administrator",
  "controller", "bookkeeper", "payroll",
  // Clinical research / care-delivery management — not quota-carrying sales.
  "clinical study manager", "clinical study lead", "clinical study specialist",
  "clinical study quality", "clinical study documentation",
  "clinical manager", "clinical care transition", "clinical transition specialist",
  "clinical healthcare operations", "clinical assessment specialist",
  "clinical services group", "medical support specialist",
  "client experience representative", "customer onboarding specialist",
  // Front-office / patient-access roles share "specialist" vocabulary with
  // commercial titles but are care-delivery operations, not selling.
  "medical front office", "front office patient", "patient service specialist",
  "patient access specialist", "patient access representative",
  "front desk", "receptionist",
  // Clinical education / services management without commercial language.
  "clinical education manager", "clinical services manager",
  "clinical field specialist", "clinical pharmacy specialist",
  "clinical program manager", "clinical operations",
  "global medical information", "medical information manager",
];

const STRONG_TITLE_SIGNALS = [
  "account executive", "account manager", "territory manager",
  "territory sales", "business development", "key account",
  "territory representative", "sales representative", "sales manager",
  "sales director", "sales specialist", "sales consultant",
  "commercial sales", "field sales", "strategic account",
  "national account", "regional sales", "district sales",
  "area sales", "veterinary sales", "animal health sales",
  "pharmaceutical sales", "medical sales", "device sales",
  "diagnostics sales", "laboratory sales",
  // Pharma/device commercial titles that omit the bare word "sales".
  "oncology account specialist", "oncology account representative",
  "territory business manager", "territory account specialist",
  "medical account specialist",
];

// Commercial titles that are usually sales in ROOK's markets, but can be
// ambiguous without the word "sales". Admitted from title alone only when
// they are not clinical-care titles.
const COMMERCIAL_TITLE_PATTERNS = [
  /\b(?:key|strategic|national|regional|area|territory|district)\s+account\s+(?:manager|executive|director)\b/i,
  // Territory Manager is a standard med-sales title. Bare district/regional/
  // area manager titles are ambiguous and require description evidence below.
  /\bterritory\s+manager\b/i,
  /\bterritory\s+business\s+manager\b/i,
  /\bterritory\s+account\s+(?:specialist|manager|executive|representative)\b/i,
  /\bbusiness\s+development\s+(?:manager|representative|director|executive)\b/i,
  /\b(?:medical|clinical)\s+account\s+(?:manager|executive|specialist)\b/i,
  /\bcommercial\s+(?:director|manager|lead)\b/i,
  // Therapy-area + Account Specialist/Representative is the standard US
  // pharma commercial naming pattern (Oncology Account Specialist, etc.).
  /\b(?:oncology|dermatology|neuroscience|hematology|cardiology|rheumatology|neurology|urology|gastroenterology|endocrinology|immunology|respiratory|migraine|ophthalmology|psychiatry|rare\s+disease|specialty)\s+account\s+(?:specialist|manager|executive|representative)\b/i,
  /\b(?:major|corporate|national|strategic)\s+accounts?\s+(?:manager|executive|director)\b/i,
  /\b(?:executive|manager|director),?\s+corporate\s+accounts?\b/i,
  /\bdiagnostics\s+solutions\s+(?:executive|consultant|manager)\b/i,
];

const DESCRIPTION_SALES_EVIDENCE = [
  /\bquota\b/i,
  /\bbook of business\b/i,
  /\bsales territory\b/i,
  /\bterritory sales\b/i,
  /\bachieve(?:ment)?\s+(?:of\s+)?sales\b/i,
  /\bsell(?:ing|s)?\b/i,
  /\bpromote\b.{0,40}\bproduct/i,
  /\bcommercial\s+(?:sales|responsibility|objectives|goals)\b/i,
  /\bcustomer\s+acquisition\b/i,
  /\brevenue\s+target/i,
  /\bclose\s+(?:new\s+)?business\b/i,
  /\bsales\s+(?:goals?|targets?|objectives?|performance)\b/i,
  /\bcall\s+on\b.{0,40}\b(?:physician|hcp|healthcare|clinic|hospital|account)/i,
  /\b(?:promote|detail)\b.{0,60}\b(?:brand|portfolio|product)/i,
  /\bhealthcare\s+professionals?\b.{0,80}\b(?:sell|promote|educate)/i,
];

const DESCRIPTION_CLINICAL_PRIMARY = [
  /\bpatient\s+care\b/i,
  /\bclinical\s+practice\b/i,
  /\bprovide\s+(?:veterinary|medical)\s+care\b/i,
  /\bdiagnose\s+and\s+treat\b/i,
  /\bsurgical\s+procedures?\b/i,
  /\bdvm\b|\bvmd\b|\bdvm\/vmd\b/i,
];

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return [
      value.description_text,
      value.description,
      value.description_html,
      value.jobDescription,
      value.job_description,
      value.detail?.jobAd?.sections?.jobDescription?.text,
    ].filter(Boolean).join(' ');
  }
  return String(value);
}

function isInternalSalesRole(title = '') {
  const t = String(title).toLowerCase();
  return /\bsales[ -]+ops\b/.test(t) ||
    (/\b(?:manager|director|head|lead|vp|vice president)\b/.test(t) &&
     /\bsales\s*(?:and|&)\s*(?:customer\s+)?service\b/.test(t));
}

function isExcludedTitle(title = '') {
  const t = String(title).toLowerCase();
  if (isInternalSalesRole(t)) return true;
  if (EXCLUSION_SIGNALS.some((k) => t.includes(k))) return true;
  if (CLINICAL_CARE_EXCLUSIONS.some((k) => t.includes(k))) return true;
  // Bare clinical-care specialist titles without commercial language.
  if (/\b(?:veterinary|clinical)\s+specialist\b/.test(t) && !/\b(?:sales|account|commercial|territory)\b/.test(t)) {
    return true;
  }
  // RN / care-transition titles are care delivery even when "manager" appears.
  if (/\brn\b/.test(t) && !/\b(?:sales|account|commercial|territory)\b/.test(t)) {
    return true;
  }
  return false;
}

function titleHasStrongSalesSignal(title = '') {
  const t = String(title).toLowerCase();
  if (isExcludedTitle(t)) return false;
  return /\bsales\b|\bsalesperson\b/.test(t) || STRONG_TITLE_SIGNALS.some((k) => t.includes(k));
}

function titleHasCommercialPattern(title = '') {
  const t = String(title || '');
  if (isExcludedTitle(t)) return false;
  return COMMERCIAL_TITLE_PATTERNS.some((pattern) => pattern.test(t));
}

function descriptionHasSalesEvidence(description = '') {
  const text = textOf(description);
  if (!text || text.length < 40) return false;
  if (DESCRIPTION_CLINICAL_PRIMARY.some((pattern) => pattern.test(text)) &&
      !DESCRIPTION_SALES_EVIDENCE.some((pattern) => pattern.test(text))) {
    return false;
  }
  return DESCRIPTION_SALES_EVIDENCE.some((pattern) => pattern.test(text));
}

// Canonical admission API. Prefer this over titleLooksRelevant when a
// description is available (ingest / adapters that already fetched detail).
function isSalesAdmissibleJob({ title = '', description = '' } = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return false;
  if (isExcludedTitle(cleanTitle)) return false;
  if (titleHasStrongSalesSignal(cleanTitle)) return true;
  if (titleHasCommercialPattern(cleanTitle)) return true;
  // Ambiguous commercial titles require description evidence. Do not admit
  // on industry vocabulary alone — preserve genuine ambiguity rather than
  // forcing a yes/no from the title string.
  if (/\b(?:district manager|area manager|regional manager|clinical specialist|medical specialist|account director|account specialist|business manager|solutions (?:consultant|executive)|clinical oncology specialist|account representative|corporate accounts?|major accounts?)\b/i.test(cleanTitle)) {
    return descriptionHasSalesEvidence(description);
  }
  return false;
}

function titleLooksRelevant(title = '', descriptionOrJob = '') {
  return isSalesAdmissibleJob({
    title,
    description: textOf(descriptionOrJob),
  });
}

module.exports = {
  titleLooksRelevant,
  titleHasStrongSalesSignal,
  isInternalSalesRole,
  isSalesAdmissibleJob,
  isExcludedTitle,
  descriptionHasSalesEvidence,
};
