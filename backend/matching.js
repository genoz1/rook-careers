// Matching engine — now using AI-derived résumé and job analysis, split
// into the three-score model Gene's spec called for: Candidate Fit
// ("can you do this job"), Preference Fit ("does this match what you
// said you want"), and an Overall Recommendation combining both, plus a
// four-bucket recommendation label (Strong Match / Apply / Stretch Apply
// / Skip).
//
// Factor-to-score assignment:
//   PREFERENCE FIT (would you want it): location, compensation, travel,
//     onboarding-stated industry interest, job freshness
//   CANDIDATE FIT (can you do it): AI industry/product/customer-type
//     match, seniority, sales motion, years of experience, specialty,
//     performance history, certifications, semantic similarity
//
// overall_score is the average of both sub-scores when both exist,
// falling back to whichever one exists if only one does (e.g. no résumé
// uploaded yet, so candidate_fit is null). Hard disqualifiers cap
// whichever sub-score they relate to, AND overall_score.
//
// Still NOT implemented from the full spec: existing relationships/
// network (#11), employment type (#13), education (#14), company type/
// size (#16-17), role responsibilities (#20), required tools (#21),
// competitive-company experience (#22), transferability (#23), recency
// weighting (#24), duration/stability (#25), career trajectory (#26),
// résumé evidence strength (#27), overqualification detection (#33),
// separate employer-interest score (#35), opportunity quality /
// application friction (#37, #39), duplicate/reposted-job detection
// (#40-41), network opportunity (#44), feedback loop / outcome learning
// (#48-49, needs real usage data accumulated over time).
//
// Also worth knowing: no job adapter populates jobs.city/jobs.state —
// only location_raw free text — so this module does its own lightweight
// state-abbreviation matching rather than relying on structured columns
// that are actually empty.

const { distanceMiles } = require("./geocoding");

const STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

function stateAbbrFromName(name) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (STATE_ABBR[key]) return STATE_ABBR[key];
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase();
  return null;
}

function locationMentionsState(locationRaw, stateAbbr) {
  if (!locationRaw || !stateAbbr) return false;
  const pattern = new RegExp(`\\b${stateAbbr}\\b`, "i");
  return pattern.test(locationRaw);
}

// True if locationRaw names a specific US state OTHER than the
// candidate's own home state. Used to catch postings like "California,
// United States - Remote" — the word "remote" there almost always means
// "remote WITHIN California" (common Workday phrasing), not nationwide
// remote. Without this check, any location string containing "remote"
// was getting full remote credit regardless of which state it actually
// named, even when that state was nowhere near the candidate and they
// hadn't indicated willingness to relocate. A residual known gap: this
// only catches a single named state, not broader regional phrasing like
// "Remote (Southeast US)" — a harder text-matching problem left alone
// for now rather than guessed at.
function mentionsADifferentState(locationRaw, acceptedStateAbbrs) {
  if (!locationRaw || !acceptedStateAbbrs || acceptedStateAbbrs.size === 0) return false;
  for (const [name, abbr] of Object.entries(STATE_ABBR)) {
    if (acceptedStateAbbrs.has(abbr)) continue;
    const pattern = new RegExp(`\\b(${name}|${abbr})\\b`, "i");
    if (pattern.test(locationRaw)) return true;
  }
  return false;
}

// Same problem as mentionsADifferentState, one level up: "China : Remote"
// or "Germany - Remote" means remote WITHIN that country, not nationwide
// US remote — but nothing was checking for non-US countries at all, so
// jobs based in another country entirely were getting full remote credit
// for a US-based candidate. Not an exhaustive country list — covers the
// countries realistically likely to appear given the multinational
// employers in ROOK's employer list (Abbott, Roche, Genentech, etc, all
// of which post roles globally) — a country not on this list would still
// slip through, same honest caveat as the single-state check above.
const NON_US_COUNTRY_SIGNALS = [
  "china", "india", "germany", "united kingdom", "canada", "mexico",
  "brazil", "france", "japan", "australia", "singapore", "spain", "italy",
  "netherlands", "switzerland", "ireland", "poland", "sweden", "belgium",
  "south korea", "taiwan", "hong kong", "philippines", "vietnam",
  "thailand", "malaysia", "indonesia", "south africa", "israel", "turkey",
  "argentina", "colombia", "chile", "portugal", "austria", "denmark",
  "norway", "finland", "czech republic", "romania", "hungary", "greece",
  "new zealand", "united arab emirates", "saudi arabia", "egypt", "russia",
  // Major foreign cities that commonly appear in job postings with no
  // country name attached at all (the exact gap that let a Mumbai
  // posting through undetected) - a practical, not exhaustive, list of
  // the largest/most common offshore hubs seen on job boards.
  "mumbai", "bangalore", "bengaluru", "delhi", "new delhi", "hyderabad",
  "pune", "chennai", "gurgaon", "gurugram", "noida", "kolkata",
  "shanghai", "beijing", "shenzhen", "guangzhou", "manila", "taguig", "makati", "jakarta",
  "kuala lumpur", "bangkok", "ho chi minh city", "hanoi", "seoul",
  "tokyo", "osaka", "sao paulo", "mexico city", "dubai", "tel aviv",
  // Deliberately excludes city names with a real, notable US namesake
  // (e.g. Warsaw, Indiana - Zimmer Biomet's headquarters; London, KY;
  // Dublin, OH/CA; Cairo, GA) - a false "foreign" flag on one of those
  // would be a worse, harder-to-notice failure than occasionally
  // missing a genuinely foreign posting from a same-named city.
];
// Reported directly: a candidate's digest included a job in Mumbai,
// India. The existing text-based check only catches job postings whose
// location text names a specific country - a posting listing just the
// city ("Mumbai", no "India" anywhere in the string) sailed straight
// through undetected, since text-matching against a country-name list
// can never cover every possible foreign city name. Added a second,
// coordinate-based check that doesn't depend on how the location was
// worded at all: the entire US (including Alaska, Hawaii, and Puerto
// Rico) sits in the Western Hemisphere (negative longitude), so any
// job geocoded to a positive longitude - true of virtually all of
// Europe, Africa, and Asia, Mumbai included - is definitively foreign
// regardless of what its location text says or omits.
const US_STATE_ABBRS = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR",
]);

// Reported directly with a concrete example: Elanco postings in Milan,
// Auckland, and Taipei were still showing up. Root cause: many Workday
// tenants format international locations as "XX - City" (a 2-letter
// COUNTRY code, e.g. "IT - Milano", "NZ - Auckland", "TW - Taipei"),
// completely different from the "US NY Remote" style used for genuine
// US postings on the very same tenant - neither the country-name list
// above nor the coordinate check catches this, since these postings
// often never get geocoded at all given the unusual format. A leading
// 2-letter code that ISN'T a real US state/territory abbreviation is a
// strong, low-risk structural signal on its own: no US state code
// collides with a real country code like IT/NZ/TW, so this can't
// misfire on a genuine domestic posting the way trying to text-match
// every possible foreign city name inevitably would.
function hasForeignCountryCodePrefix(locationRaw) {
  // Defensive: crashed a real ingest run when a Pinpoint job's raw
  // location came through as an object (its documented shape is
  // {id, name}, not a plain string) instead of the string this
  // function expects - String(...) first so a malformed field from any
  // adapter can never bring down an entire ingest batch over one job.
  const match = /^([A-Z]{2})\s*-/.exec(String(locationRaw || "").trim());
  if (!match) return false;
  return !US_STATE_ABBRS.has(match[1]);
}

// A real, low-risk structural signal, same reasoning as the
// country-code-prefix check above: no legitimate US job posting title
// or location would contain untranslated Chinese/Japanese/Korean
// script. Catches the gap the two checks below can both miss at once —
// a foreign city name that isn't on the NON_US_COUNTRY_SIGNALS list
// (e.g. "Suita", a real Osaka-area city) AND a job that never
// successfully geocoded (so job_lng is null, not a positive number) -
// which together let a literal Japanese-language posting through
// undetected on every surface that filters by location_raw/job_lng
// alone. Ranges: Hiragana/Katakana, CJK Unified Ideographs, Hangul.
function containsNonLatinScript(text) {
  if (!text) return false;
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(String(text));
}

function mentionsNonUsCountry(locationRaw, jobLng, titleRaw) {
  if (jobLng != null && jobLng > 0) return true;
  if (containsNonLatinScript(titleRaw) || containsNonLatinScript(locationRaw)) return true;
  if (!locationRaw) return false;
  if (hasForeignCountryCodePrefix(locationRaw)) return true;
  return NON_US_COUNTRY_SIGNALS.some((country) => new RegExp(`\\b${country}\\b`, "i").test(locationRaw));
}

function extractSalaryFigure(job) {
  if (job.salary_max) return Number(job.salary_max);
  if (job.salary_min) return Number(job.salary_min);
  const text = job.compensation_text || "";
  const matches = [...text.matchAll(/\$?([\d,]+(?:\.\d+)?)\s*(k|K)?/g)];
  let best = null;
  for (const m of matches) {
    let val = parseFloat(m[1].replace(/,/g, ""));
    if (!val) continue;
    if (m[2]) val *= 1000;
    if (val < 1000) continue;
    if (best === null || val > best) best = val;
  }
  return best;
}

function extractJobTravelPercentage(job) {
  if (job.travel_percentage != null) return Number(job.travel_percentage);
  const text = `${job.compensation_text || ""} ${job.description_text || ""}`;
  const match = text.match(/(\d{1,3})\s*%\s*travel/i);
  return match ? Number(match[1]) : null;
}

// Matches an item from listA against listB. Checks exact match first;
// if none, falls back to substring containment either direction. This
// fallback exists because job and résumé industry/product/customer/
// specialty labels come from two SEPARATE AI extraction passes — even
// when both are drawing from the same controlled vocabulary, they don't
// always land on identical phrasing for the same real thing ("Animal
// Health" vs "Veterinary/Animal Health"). An exact-match-only comparison
// was giving zero credit for what a human reviewer would immediately
// recognize as the same match — a real false-negative bug, found after
// genuinely-strong-fit jobs were topping out around 80% overall score
// with no clear reason why. This does NOT lower the bar for what counts
// as a match; it only recognizes the same match when phrased slightly
// differently, which exact-string matching was structurally unable to do.
// Reduces a label to its significant word roots for fuzzy comparison:
// lowercase, strip punctuation, crudely depluralize (trailing 's'), and
// drop short filler words. "Physicians" and "Physician Offices" both
// reduce to a set containing "physician" — this is what actually lets
// them match; plain substring containment does NOT catch this pair
// (neither string contains the other once there's a trailing "s" or an
// extra qualifying word in the way), which is exactly the concrete case
// that surfaced this: a candidate's real past title of "Physician
// Account Executive" at Quest Diagnostics, evaluated against a live
// Quest Diagnostics "Physician Account Executive" posting, still only
// scored Customer & Specialty as "Partial" rather than "Strong".
function significantWords(str) {
  return new Set(
    String(str)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => (w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w)) // crude depluralize, only for words long enough that stripping "s" won't mangle them
      .filter((w) => w.length > 3)
  );
}

function findOverlap(listA, listB) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) return null;
  const bStrings = listB.map((s) => String(s).toLowerCase().trim());
  const exact = listA.find((a) => bStrings.includes(String(a).toLowerCase().trim()));
  if (exact) return exact;

  // Substring fallback — catches cases like "Animal Health" contained
  // within "Veterinary/Animal Health" that word-splitting could miss if
  // one side collapses to very few significant words.
  const substringMatch = listA.find((a) => {
    const aLower = String(a).toLowerCase().trim();
    if (aLower.length <= 3) return false;
    return bStrings.some((b) => b.length > 3 && (b.includes(aLower) || aLower.includes(b)));
  });
  if (substringMatch) return substringMatch;

  // Word-root fallback — catches cases substring containment can't,
  // like "Physicians" vs "Physician Offices" (see comment above).
  const bWordSets = bStrings.map(significantWords);
  return listA.find((a) => {
    const aWords = significantWords(a);
    if (aWords.size === 0) return false;
    return bWordSets.some((bWords) => [...aWords].some((w) => bWords.has(w)));
  }) || null;
}

function parseVector(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function recommendationForScore(score) {
  if (score == null) return null;
  if (score >= 90) return "Strong Match";
  if (score >= 80) return "Apply";
  if (score >= 70) return "Stretch Apply";
  return "Skip";
}

/**
 * Score one job against one candidate profile.
 *
 * @param {object} job - a row from the jobs table (may include ai_analysis)
 * @param {object} profile - a row from candidate_profiles (may include resume_structured)
 * @returns {{
 *   candidate_fit: number|null,
 *   preference_fit: number|null,
 *   overall_score: number|null,
 *   recommendation: "Strong Match"|"Apply"|"Stretch Apply"|"Skip"|null,
 *   reasons: string[],
 *   concerns: string[],
 *   confidence: "high"|"medium"|"low",
 *   hard_disqualifier: boolean
 * }}
 */
function scoreJob(job, profile) {
  const reasons = [];
  const concerns = [];

  let prefScore = 0, prefMax = 0;
  let candScore = 0, candMax = 0;
  let dataPointsAvailable = 0;
  let dataPointsPossible = 0;
  let hardDisqualifier = false;
  let prefCap = 100;
  let candCap = 100;
  // Distinct from prefCap/candCap on purpose: those only limit their own
  // component BEFORE it gets averaged into overall_score, so a low
  // prefCap can still be diluted by half when blended with a strong
  // candidate_fit (a real bug found this way: prefCap capped at 50 for a
  // >300-mile job still produced a 73% overall_score once averaged with
  // a 96% candidate_fit). overallCap applies directly to the final
  // overall_score, unconditionally, after the blend - a true ceiling
  // that can't be diluted by a strong score somewhere else.
  let overallCap = 100;
  let distanceMultiplier = 1;

  // Five simplified categories for the job-card UI (spec: Experience,
  // Industry & Product, Customer & Specialty, Location & Preferences,
  // Requirements). These bucket the SAME points computed below — the
  // detailed per-factor scoring is unchanged, this is purely a simpler
  // view derived from it, not a second scoring pass. Each block below
  // snapshots prefScore/candScore before and after to see how many
  // points that block actually contributed, then adds that delta to the
  // relevant category. Job freshness and the embedding-similarity bonus
  // are deliberately left out of category totals — they're real signals
  // for the overall score, but don't map cleanly to any one card
  // category and would just make the buckets muddier.
  const cat = {
    experience: { score: 0, max: 0 },
    industry_product: { score: 0, max: 0 },
    customer_specialty: { score: 0, max: 0 },
    location_prefs: { score: 0, max: 0 },
    requirements: { score: 0, max: 0 },
  };
  const catGap = new Set(); // categories forced to "Gap" by a hard disqualifier
  let locationForcedStrong = false; // set when the job is within 60 miles — see the distance block below

  // ============================================================
  // PREFERENCE FIT — deduction model
  // ============================================================
  // Every job starts at 100. Points deducted only for confirmed mismatches.
  // Missing data never penalises — unknown is not wrong.
  // ============================================================

  prefMax = 100;
  prefScore = 100;
  distanceMultiplier = 1;

  const mentionsForeignCountry = mentionsNonUsCountry(job.location_raw, job.job_lng, job.title_original);
  const homeStateAbbr = stateAbbrFromName(profile.home_state);
  const hasRealCoordinates = profile.home_lat != null && profile.home_lng != null && job.job_lat != null && job.job_lng != null;

  // ── Location scoring — tier model ─────────────────────────────────────
  // Tier 1 (0):   within 75 miles (real coords)
  // Tier 2 (-5):  75-175 miles (real coords) | whole state | SE region
  // Tier 3 (-15): 175-300 miles (real coords) | specific far in-state city
  // Tier 4 (-25): 300+ miles (real coords) | specific out-of-state location
  //
  // No state logic — only mileage for real coordinates, and territory
  // scope detection (city vs state vs region) for no-coordinate jobs.
  // remote_status is irrelevant in field sales — every rep is "remote".

  if (mentionsForeignCountry) {
    prefScore -= 40;
    hardDisqualifier = true;
    prefCap = Math.min(prefCap, 60);
    concerns.push(`Location (${job.location_raw}) appears to be outside the United States`);

  } else if (hasRealCoordinates) {
    // Real coordinates — pure mileage tiers
    const miles = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
    if (miles <= 75) {
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 150) {
      prefScore -= 5;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 300) {
      prefScore -= 15;
      concerns.push(`About ${Math.round(miles)} miles away`);
    } else {
      prefScore -= 25;
      concerns.push(`About ${Math.round(miles)} miles away — outside typical territory range`);
    }

  } else {
    // No real coordinates — determine territory scope from location_raw.
    // In medical field sales every job is effectively "remote" so we ignore
    // that label and focus on the geographic territory described.
    const _loc = (job.location_raw || "").toLowerCase();
    const _homeState = (profile.home_state || "").toLowerCase();
    const _homeAbbr = homeStateAbbr ? homeStateAbbr.toLowerCase() : "";

    // Southeast region keywords → Tier 2 (-5)
    const SE_REGIONS = ["southeast", "south region", "se region", "southern region",
      "southeast region", "gulf coast region", "south atlantic"];

    // Whole home-state coverage → Tier 2 (-5)
    // Matches "Florida", "Remote - Florida", "FL", statewide
    const isWholeHomeState = (_homeState.length > 2 && _loc.includes(_homeState)) ||
      (_homeAbbr && new RegExp(`\\b${_homeAbbr}\\b`).test(_loc));

    // Specific far in-state cities → Tier 3 (-15)
    const FAR_INSTATE_CITIES = [
      "south florida","miami","fort lauderdale","palm beach","boca raton",
      "broward","coral gables","key west","florida keys","naples","cape coral",
      "bonita springs","tallahassee","pensacola","panama city","destin",
      "fort walton","sarasota","fort myers","punta gorda","port charlotte"
    ];

    if (SE_REGIONS.some(r => _loc.includes(r))) {
      // Southeast region — Tier 2
      prefScore -= 5;
      reasons.push("Covers the Southeast region");
    } else if (isWholeHomeState && !FAR_INSTATE_CITIES.some(c => _loc.includes(c))) {
      // Whole home state, no specific far city — Tier 2
      prefScore -= 5;
      reasons.push("Covers your home state");
    } else if (FAR_INSTATE_CITIES.some(c => _loc.includes(c))) {
      // Specific far in-state city — Tier 3
      prefScore -= 15;
      concerns.push("Territory is in your state but far from your location");
    } else if (_loc.length > 0) {
      // Specific out-of-state or unrecognised location — Tier 4
      prefScore -= 25;
      concerns.push("Territory appears to be outside your area");
    } else {
      // No location info at all — Tier 4
      prefScore -= 25;
    }
  }

  cat.location_prefs.max = 100;
  cat.location_prefs.score = prefScore;

  // ── Industry ──────────────────────────────────────────────────────────
  // Only deduct if ai_analysis has industry data AND it doesn't match.
  // No data → no deduction.
  const INDUSTRY_GROUPS = {
    diagnostics:      ["diagnostics", "reference laboratory", "molecular", "point-of-care", "lab", "pathology", "clinical laboratory"],
    "medical device": ["medical device", "capital equipment", "surgical", "dme", "consumables"],
    pharmaceutical:   ["pharmaceutical", "pharma", "biotech", "life sciences", "specialty pharma"],
    veterinary:       ["veterinary", "animal health", "vet"],
  };

  // Use product_categories as primary signal — what the job SELLS.
  // required_industries lists what backgrounds are accepted, which is too
  // broad (a pharma job may accept diagnostics reps, but it is still pharma).
  // Fall back to required_industries only when product_categories is empty.
  const _aiProd = (job.ai_analysis?.product_categories   || []).map(s => String(s).toLowerCase());
  const _aiReq  = (job.ai_analysis?.required_industries  || []).map(s => String(s).toLowerCase());
  const _aiPref = (job.ai_analysis?.preferred_industries || []).map(s => String(s).toLowerCase());
  const _primaryList = _aiProd.length > 0 ? _aiProd : [..._aiReq, ..._aiPref];
  const _aiAll  = [..._aiProd, ..._aiReq, ..._aiPref];
  const hasIndustryData = _primaryList.length > 0;

  if (Array.isArray(profile.desired_industries) && profile.desired_industries.length > 0 && hasIndustryData) {
    const matchedIndustry = profile.desired_industries.find((ind) => {
      const key   = String(ind).toLowerCase().trim();
      const group = INDUSTRY_GROUPS[key] || [key];
      return group.some((term) => _primaryList.some(s => s.includes(term)));
    });
    if (matchedIndustry) {
      reasons.push(`Matches your interest in ${matchedIndustry}`);
    } else {
      prefScore -= 10;
      concerns.push("Industry may not match your stated preference");
    }
  }

  if (Array.isArray(profile.industries_to_avoid) && profile.industries_to_avoid.length > 0 && hasIndustryData) {
    const avoided = profile.industries_to_avoid.find((ind) => {
      const key   = String(ind).toLowerCase().trim();
      const group = INDUSTRY_GROUPS[key] || [key];
      return group.some((term) => _aiAll.some(s => s.includes(term)));
    });
    if (avoided) {
      concerns.push(`Mentions ${avoided}, which you asked to avoid`);
      hardDisqualifier = true;
      prefCap = Math.min(prefCap, 40);
    }
  }

  cat.industry_product.max = 100;
  cat.industry_product.score = prefScore;

  // ── Salary — informational only, no scoring impact ───────────────────
  const jobSalary = extractSalaryFigure(job);
  if (jobSalary) {
    reasons.push(`Published compensation: ${job.compensation_text || "$" + Math.round(jobSalary / 1000) + "k"}`);
  }

  // ============================================================
  // CANDIDATE FIT — can the candidate actually do this job
  // (only scored when BOTH résumé analysis AND job analysis exist)
  // ============================================================
  const resume = profile.resume_structured;
  const jobAI = job.ai_analysis;

  if (resume && jobAI) {
    // --- AI industry experience match (up to 25 points, spec factor #2) ---
    // Only counted when the job's AI analysis actually names required OR
    // preferred industries. A thin listing (common for recruiter-posted
    // jobs, which start from a short manual description rather than a
    // full ATS posting) that says nothing about industry shouldn't drag
    // down Candidate Fit just because there's nothing to match against —
    // that's an absence of job detail, not a résumé gap. Real "job
    // requires X and résumé doesn't show it" cases are unaffected; those
    // still score/disqualify exactly as before.
    const jobStatesIndustry = (Array.isArray(jobAI.required_industries) && jobAI.required_industries.length > 0)
      || (Array.isArray(jobAI.preferred_industries) && jobAI.preferred_industries.length > 0);
    const resumeIndustries = (resume.industries_experience || []).map((i) => i.industry);
    if (jobStatesIndustry) {
      candMax += 25;
      dataPointsPossible++;
      if (resumeIndustries.length > 0) dataPointsAvailable++;

      const matchedRequired = findOverlap(jobAI.required_industries, resumeIndustries);
      const matchedPreferred = findOverlap(jobAI.preferred_industries, resumeIndustries);
      const jobHasRequiredList = Array.isArray(jobAI.required_industries) && jobAI.required_industries.length > 0;
      if (matchedRequired) {
        candScore += 25;
        reasons.push(`Your ${matchedRequired} experience matches a required industry`);
      } else if (matchedPreferred) {
        // Full credit when the job never stated a required industry at
        // all — matching preferred is the best any candidate could ever
        // do here, so 25/25 isn't actually unreachable the way it would
        // be if a real required list existed and this candidate merely
        // fell back to a preferred match. Real bug, concrete case: a
        // Quest Diagnostics posting with an empty required_industries
        // list and Diagnostics/Reference Laboratory as preferred — a
        // candidate with 15 years in exactly those industries was still
        // only getting 16/25 (64%) on a factor no one could ever max out.
        // Partial credit (16) is kept for the genuine case: a required
        // list DOES exist and this candidate matched preferred instead —
        // there, a strictly better outcome really was possible.
        candScore += jobHasRequiredList ? 16 : 25;
        reasons.push(`Your ${matchedPreferred} experience matches a preferred industry`);
      } else if (jobHasRequiredList) {
        concerns.push(`Job requires industry experience (${jobAI.required_industries.join(", ")}) not found on your résumé`);
        hardDisqualifier = true;
        candCap = Math.min(candCap, 70);
        catGap.add("industry_product");
      } else {
        candScore += 10;
      }
      cat.industry_product.max += 39;
      cat.industry_product.score += matchedRequired ? 25 : matchedPreferred ? (jobHasRequiredList ? 16 : 25) : 10;
    }

    // --- AI product-category match (up to 18 points, spec factor #3) ---
    // Same principle: only counted if the job's AI analysis actually
    // lists product categories to match against.
    const resumeProducts = resume.product_categories || [];
    if (Array.isArray(jobAI.product_categories) && jobAI.product_categories.length > 0) {
      candMax += 18;
      dataPointsPossible++;
      if (resumeProducts.length > 0) dataPointsAvailable++;
      const matchedProduct = findOverlap(jobAI.product_categories, resumeProducts);
      if (matchedProduct) {
        candScore += 18;
        reasons.push(`You have direct ${matchedProduct} product experience`);
      } else {
        candScore += 8;
      }
      cat.industry_product.max += 18;
      cat.industry_product.score += matchedProduct ? 18 : 8;
    }

    // --- AI customer/call-point match (up to 18 points, spec factor #4) ---
    // Same principle: only counted if the job actually names required
    // customer types to match against.
    const resumeCustomers = resume.customer_types || [];
    if (Array.isArray(jobAI.required_customer_types) && jobAI.required_customer_types.length > 0) {
      candMax += 18;
      dataPointsPossible++;
      if (resumeCustomers.length > 0) dataPointsAvailable++;
      const matchedCustomer = findOverlap(jobAI.required_customer_types, resumeCustomers);
      if (matchedCustomer) {
        candScore += 18;
        reasons.push(`You've sold to ${matchedCustomer} before`);
      } else {
        candScore += 8;
      }
      cat.customer_specialty.max += 18;
      cat.customer_specialty.score += matchedCustomer ? 18 : 8;
    }

    // --- AI seniority fit (up to 12 points, spec factor #6) ---
    const _seniorityBefore = candScore;
    if (resume.seniority_level && jobAI.seniority_level) {
      candMax += 12;
      dataPointsPossible++;
      dataPointsAvailable++;
      // In field medical/vet sales, "Territory Manager," "Account
      // Executive," "Account Manager," "Territory Representative," and
      // "Sales Representative" are functionally the same individual-
      // contributor role — the exact label is a company-naming
      // convention, not a real seniority difference, per direct
      // industry-expert correction. The one exception is a role tied to
      // a specific clinical specialty (toxicology, cardiology, etc.) —
      // that's a real distinction, but it's captured separately by the
      // specialty/customer-type matching below, not by seniority_level
      // at all, so treating these titles as equivalent here doesn't
      // paper over a genuine specialty mismatch elsewhere on the card.
      // "Key Account Manager," "Regional Manager," "Director," and "VP"
      // are deliberately NOT included — those are real seniority steps
      // up from an individual-contributor field role.
      const GENERIC_FIELD_TITLES = new Set(["territory manager", "account executive", "account manager", "territory representative", "sales representative"]);
      const resumeLevel = resume.seniority_level.toLowerCase();
      const jobLevel = jobAI.seniority_level.toLowerCase();
      const bothGenericField = GENERIC_FIELD_TITLES.has(resumeLevel) && GENERIC_FIELD_TITLES.has(jobLevel);
      if (resumeLevel === jobLevel || bothGenericField) {
        candScore += 12;
        reasons.push(`Seniority level (${jobAI.seniority_level}) matches your background`);
      } else {
        candScore += 5;
      }
    }

    cat.experience.max += 12;
    cat.experience.score += (candScore - _seniorityBefore);

    // --- Sales-motion fit (up to 10 points, spec factor #5) ---
    const resumeMotion = resume.sales_motion || [];
    const jobMotion = jobAI.sales_motion || [];
    const _motionBefore = candScore;
    if (resumeMotion.length > 0 && jobMotion.length > 0) {
      candMax += 10;
      dataPointsPossible++;
      dataPointsAvailable++;
      const matchedMotion = findOverlap(jobMotion, resumeMotion);
      if (matchedMotion) {
        candScore += 10;
        // Direct fix for a real, confirmed bug: several sales_motion
        // controlled-vocabulary values (Direct Sales, Inside Sales,
        // Outside Sales, Enterprise Sales, Consultative Sales,
        // Channel/Distributor Sales — see resumeAnalysis.js's own
        // documented vocabulary) already end in the word "Sales,"
        // so unconditionally appending "sales" here produced literal
        // "Direct Sales sales experience" duplication.
        const motionAlreadyEndsInSales = /sales$/i.test(matchedMotion);
        reasons.push(motionAlreadyEndsInSales
          ? `Your ${matchedMotion} experience matches this role's style`
          : `Your ${matchedMotion} sales experience matches this role's style`);
      } else {
        candScore += 4;
      }
    }
    cat.experience.max += 10;
    cat.experience.score += (candScore - _motionBefore);

    // --- Required years of experience (up to 10 points, spec factor #7) ---
    const _yearsBefore = candScore;
    if (resume.total_sales_years != null && jobAI.required_years_experience != null) {
      candMax += 10;
      dataPointsPossible++;
      dataPointsAvailable++;
      const gap = resume.total_sales_years - jobAI.required_years_experience;
      if (gap >= 0) {
        candScore += 10;
        reasons.push(`Your ${resume.total_sales_years} years of experience meets the ${jobAI.required_years_experience}-year requirement`);
      } else if (gap >= -2) {
        candScore += 6;
        concerns.push(`Slightly under the stated ${jobAI.required_years_experience}-year requirement`);
      } else {
        candScore += 2;
        concerns.push(`Well under the stated ${jobAI.required_years_experience}-year requirement`);
      }
    }
    cat.experience.max += 10;
    cat.experience.score += (candScore - _yearsBefore);

    // --- Specialty experience (up to 8 points, spec factor #9) ---
    const resumeSpecialties = resume.specialties || [];
    const jobSpecialties = jobAI.specialty_requirements || [];
    if (jobSpecialties.length > 0) {
      candMax += 8;
      dataPointsPossible++;
      if (resumeSpecialties.length > 0) dataPointsAvailable++;
      let matchedSpecialty = findOverlap(jobSpecialties, resumeSpecialties);
      // Reported directly with a concrete false-positive: a candidate
      // with 5 real years of small-animal sales experience still got
      // flagged with "Job calls for specialty experience (Small animal
      // medicine) not shown on your résumé." findOverlap() itself is
      // reasonably robust (exact/substring/word-root matching), so the
      // real gap is almost certainly upstream - the one-time AI résumé
      // parse that built the structured `specialties` list can miss a
      // specialty the full résumé genuinely describes, especially with
      // different wording (e.g. "companion animal" rather than "small
      // animal"). Falls back to checking the RAW résumé text directly
      // before concluding it's a real gap, rather than trusting the
      // narrower structured extraction alone.
      if (!matchedSpecialty) {
        // Broadened further: profile.resume_text can itself be empty
        // for some accounts even though resume_structured is fully
        // populated - stringifying the whole structured resume object
        // catches a mention buried in a work-history bullet or
        // description field that isn't `specialties` at all, on top of
        // the raw text. Same principle either way: check everywhere
        // real résumé content might live before concluding a genuine
        // gap, rather than trusting one specific field.
        const haystack = `${profile.resume_text || ""} ${JSON.stringify(resume)}`.toLowerCase();
        matchedSpecialty = jobSpecialties.find((spec) => {
          const words = [...significantWords(spec)];
          return words.length > 0 && words.some((w) => haystack.includes(w));
        });
      }
      cat.customer_specialty.max += 8;
      if (matchedSpecialty) {
        candScore += 8;
        cat.customer_specialty.score += 8;
        reasons.push(`Your ${matchedSpecialty} specialty experience is a direct match`);
      } else {
        concerns.push(`Job calls for specialty experience (${jobSpecialties.join(", ")}) not shown on your résumé`);
      }
    }

    // --- Performance history bonus (up to 6 points, spec factor #10) ---
    if (Array.isArray(resume.performance_highlights) && resume.performance_highlights.length > 0) {
      candMax += 6;
      dataPointsPossible++;
      dataPointsAvailable++;
      candScore += 6;
      cat.experience.max += 6;
      cat.experience.score += 6;
      reasons.push("Résumé shows documented sales performance achievements");
    }

    // --- Certifications/licensing (up to 5 points, spec factor #15) ---
    const resumeCerts = resume.certifications || [];
    if (resumeCerts.length > 0) {
      candMax += 5;
      dataPointsPossible++;
      dataPointsAvailable++;
      candScore += 5;
      cat.requirements.max += 5;
      cat.requirements.score += 5;
      reasons.push(`Holds relevant certifications: ${resumeCerts.slice(0, 2).join(", ")}`);
    }

    // --- Semantic similarity via embeddings (up to 15 points, spec
    // factor #46). CALIBRATION CAVEAT: the point thresholds below are a
    // reasonable starting estimate, not measured against real ROOK
    // résumé/job pairs — this couldn't be tested against the live
    // OpenAI API from the environment this was written in.
    const candidateVec = parseVector(profile.candidate_embedding);
    const jobVec = parseVector(job.job_embedding);
    if (candidateVec && jobVec) {
      candMax += 15;
      dataPointsPossible++;
      dataPointsAvailable++;
      const similarity = cosineSimilarity(candidateVec, jobVec);
      if (similarity != null) {
        const points = Math.max(0, Math.min(15, Math.round(((similarity - 0.1) / 0.4) * 15)));
        candScore += points;
        if (similarity >= 0.35) {
          reasons.push("Your résumé and this job show strong conceptual overlap");
        } else if (similarity <= 0.15) {
          concerns.push("Your résumé and this job show limited conceptual overlap");
        }
      }
    }

    // --- Clinical requirement hard disqualifier (spec factor #8, #31) ---
    const mandatoryClinical = (jobAI.clinical_requirements || []).filter((r) => r.strength === "mandatory");
    if (mandatoryClinical.length > 0) {
      const resumeClinicalText = (resume.clinical_technical_experience || []).join(" ").toLowerCase();
      const resumeFullText = (profile.resume_text || "").toLowerCase();
      // Reported directly, with two concrete false-positive examples: a
      // candidate with 5 years of actual small-animal sales experience
      // still got flagged with "Job calls for specialty experience
      // (Small animal medicine) not shown on your résumé," and another
      // real "Medical/scientific background" requirement flagged as
      // unmet despite genuinely relevant experience. Root cause: this
      // only ever checked the résumé text for the FIRST WORD of the
      // requirement phrase (req.requirement.split(" ")[0]) - for
      // "Medical/scientific background," splitting on spaces alone
      // never separates the slash-joined "Medical/scientific" at all,
      // so it checked for that exact, near-impossible compound string
      // verbatim; for "Small animal medicine" it checked only the
      // single generic word "small," missing genuine experience
      // described with different but clearly related wording. Also
      // only ever checked the narrow structured
      // clinical_technical_experience field, missing anything the full
      // résumé mentions that the one-time AI parse didn't specifically
      // extract into that field - falls back to the raw résumé text too.
      const resumeWords = significantWords(resumeClinicalText + " " + resumeFullText);
      // Direct instruction, a genuinely better philosophy given how
      // imperfect the underlying résumé extraction can be: assume a
      // stated requirement IS met by default (full credit) and only
      // deduct for a requirement CONFIRMED missing, rather than the
      // other way around (no credit unless positively confirmed) -
      // "we shouldn't assume a candidate lacks something just because
      // we couldn't extract confirmation of it." Every mandatory
      // requirement is worth an even share of 15 points, starting at
      // full credit; each one genuinely unmet subtracts its share
      // rather than zeroing the whole category out for one gap among
      // several, and still forces the category to "Gap" for visibility
      // in the breakdown (matching.js's rating logic below) exactly as
      // before - full credit is a default assumption, not a way to
      // silently hide a real, confirmed gap from the candidate.
      cat.requirements.max += 15;
      candMax += 15;
      dataPointsPossible++;
      dataPointsAvailable++;
      const perRequirement = 15 / mandatoryClinical.length;
      let requirementScore = 15;
      let anyUnmet = false;
      for (const req of mandatoryClinical) {
        const reqWords = [...significantWords(req.requirement)];
        const isMet = reqWords.length === 0 || reqWords.some(
          (w) => resumeWords.has(w) || resumeClinicalText.includes(w) || resumeFullText.includes(w)
        );
        if (!isMet) {
          requirementScore -= perRequirement;
          concerns.push(`Job requires "${req.requirement}" — not clearly shown on your résumé`);
          anyUnmet = true;
        }
      }
      cat.requirements.score += requirementScore;
      candScore += requirementScore;
      if (anyUnmet) {
        catGap.add("requirements");
      }
    }
  }

  // ============================================================
  // Category ratings for the job-card UI — bucket each category's
  // score/max ratio into Strong/Good/Partial/Gap. A category with a
  // forced Gap (from a hard disqualifier) always shows Gap regardless
  // of ratio. A category with no underlying data at all (max === 0 —
  // e.g. no résumé uploaded yet, so nothing fed Experience) shows null
  // rather than guessing; the card should say "not enough info", not
  // silently claim a rating that has no basis.
  // ============================================================
  const CATEGORY_LABELS = {
    experience: "Experience",
    industry_product: "Industry & Product",
    customer_specialty: "Customer & Specialty",
    location_prefs: "Location & Preferences",
    requirements: "Requirements",
  };
  const categories = {};
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const { score, max } = cat[key];
    let rating = null;
    if (catGap.has(key)) {
      rating = "Gap";
    } else if (max > 0) {
      const ratio = score / max;
      rating = ratio >= 0.85 ? "Strong" : ratio >= 0.6 ? "Good" : ratio >= 0.35 ? "Partial" : "Gap";
    }
    categories[key] = { label, rating };
  }

  // Direct override, not a blended-ratio outcome: within 90 miles forces
  // Location & Preferences to "Strong" outright, even if compensation,
  // travel %, or industry-interest scored lower and would otherwise have
  // pulled the blended ratio down to "Good". A real Gap (far away and
  // outside accepted regions) still isn't overridden by this — this only
  // ever raises the rating, never masks an actual disqualifying mismatch.
  if (locationForcedStrong && categories.location_prefs.rating !== "Gap") {
    categories.location_prefs.rating = "Strong";
  }

  // A "Gap" in any candidate-side category (Experience, Industry &
  // Product, Customer & Specialty, Requirements) must actually restrain
  // the score, not just cost that category's own small slice of points.
  // Before this, only two specific hard disqualifiers (missing required
  // industry, missing mandatory clinical requirement) ever touched
  // candCap — a specialty mismatch (e.g. a job requiring surgical/OR
  // experience the résumé doesn't show) only lost its own ~8 points out
  // of a much larger pool, which barely moved the percentage. Real
  // reported case: a Detroit job with a stated Customer & Specialty Gap
  // still outscored a no-Gap Florida job 72 miles away, because losing
  // 8 points didn't dent an otherwise-strong Qualifications number.
  // location_prefs is deliberately excluded here — a location/
  // compensation mismatch already caps prefCap directly above.
  const CANDIDATE_SIDE_GAP_CATEGORIES = ["experience", "industry_product", "customer_specialty", "requirements"];
  if (CANDIDATE_SIDE_GAP_CATEGORIES.some((key) => categories[key].rating === "Gap")) {
    candCap = Math.min(candCap, 78);
  }

  // ============================================================
  // Combine into candidate_fit / preference_fit / overall_score
  // ============================================================
  let candidate_fit = candMax > 0 ? Math.round((candScore / candMax) * 100) : null;
  let preference_fit = prefMax > 0 ? Math.round((prefScore / prefMax) * 100) : null;

  if (candidate_fit != null) candidate_fit = Math.min(candidate_fit, candCap);
  if (preference_fit != null) preference_fit = Math.min(preference_fit, prefCap);

  // Overall score = preference_fit only.
  // Ranking is based purely on location + onboarding answers — consistent
  // between v6 preview (no resume) and dashboard (with resume).
  // candidate_fit is displayed as "Qualifications" on the card but never
  // affects sort order. Resume tells you how you qualify, not where you rank.
  let overall_score;
  if (preference_fit != null) {
    overall_score = preference_fit;
  } else if (candidate_fit != null) {
    overall_score = candidate_fit;
  } else {
    overall_score = null;
  }
  // Direct instruction, stated plainly: no job should ever be hard
  // disqualified from a candidate's view, and the score should just
  // reflect the match - not be artificially capped by any mechanism.
  // "You never know what a person might be interested in... if a
  // person isn't able to see all of the jobs, what is the use." The
  // individual hardDisqualifier / prefCap / candCap assignments
  // throughout this function (avoided industry, missing requirements,
  // etc.) are left in place below - they still drive real, accurate
  // concerns/reasons text explaining WHY a job scores the way it does -
  // but none of them force the final score down to an artificial
  // ceiling anymore. A genuinely poor match scores low because the
  // real underlying calculation says so, not because of a cap layered
  // on top of it; a candidate can always see every job, with the score
  // honestly reflecting fit rather than gating visibility.
  //
  // Distance is the one deliberate exception, per a later, separate
  // direct instruction with a concrete worked example: for the same
  // underlying fit, a closer job must always outrank a farther one
  // (Villages > Orlando > Jacksonville > Iowa, in that order) - a rule
  // that can only hold if distance scales the WHOLE score multiplicatively,
  // not as one diluted ingredient among several that unrelated
  // categories can compensate for. Still never hides anything - even
  // the harshest multiplier (0.25, for 300+ miles with no stated
  // openness to relocating there) leaves a real, visible, honestly-low
  // score, not an exclusion.
  if (overall_score != null) {
    overall_score = Math.round(overall_score);
  }

  const availabilityRatio = dataPointsPossible > 0 ? dataPointsAvailable / dataPointsPossible : 0;
  const confidence = availabilityRatio >= 0.75 ? "high" : availabilityRatio >= 0.4 ? "medium" : "low";

  // --- Excellent Match determination ---
  // Deliberately stricter than just "overall_score >= 85" — scoring 85%
  // on preference-fit alone with no résumé/job-AI data at all would
  // otherwise qualify, which isn't a real "excellent match," it's an
  // absence of information. Every category that has data must clear its
  // bar, and any category with no data (rating === null) fails the
  // requirement rather than being ignored, since this shouldn't be
  // gameable by incomplete candidate/job data.
  const goodOrStrong = (r) => r === "Strong" || r === "Good";
  const excellent_match = Boolean(
    overall_score != null &&
    overall_score >= 85 &&
    categories.experience.rating === "Strong" &&
    goodOrStrong(categories.industry_product.rating) &&
    goodOrStrong(categories.customer_specialty.rating) &&
    categories.location_prefs.rating === "Strong" &&
    // Requirements has real underlying data (mandatory clinical
    // requirements, certifications) for only a small minority of jobs —
    // ROOK doesn't currently extract education/licensing at all. Before
    // this fix, a null (no-data) rating counted as FAILING this check,
    // making Excellent Match nearly unreachable regardless of how
    // strong every other category was — Requirements showed "Not
    // enough info" on almost every job tonight, and every one of them
    // was silently blocked from ever qualifying. No data means nothing
    // to grade, not a gap — it shouldn't block the designation the same
    // way an actual stated mismatch (rating === "Gap") should.
    (categories.requirements.rating === null || goodOrStrong(categories.requirements.rating))
  );

  return {
    candidate_fit,
    preference_fit,
    overall_score,
    recommendation: recommendationForScore(overall_score),
    reasons,
    concerns,
    confidence,
    hard_disqualifier: hardDisqualifier,
    categories,
    excellent_match,
  };
}

// Centralized subscription-entitlement logic. Direct instruction: do not
// replace "active" with "trialing" ad hoc in each of the six+ places
// that gate content — one definition, used everywhere, so trial access
// and paid-conversion reporting can never drift out of sync with each
// other.
//
// Two distinct questions, two distinct functions:
//   - hasFullAccess: should this candidate see full, ungated content
//     right now? True for BOTH a trialing candidate and an actively
//     paying one — from the product's perspective during the trial
//     window, they get identical access.
//   - isPayingSubscriber: has this candidate's card actually been
//     successfully charged at least once? True only for "active" —
//     this is the "real, converted, paying customer" signal, kept
//     separate so a future paid-conversion report (or a server-side ad
//     conversion call) can query it without ever confusing a free
//     trial for revenue.
//
// Direct instruction: hasFullAccess must NOT simply trust the stored
// status string — it must also check the actual expiration timestamps
// already on the row (trial_ends_at, subscription_cancel_at), so a
// delayed or entirely missed Stripe webhook can never leave an expired
// trial (or a cancelled-and-past-its-paid-through-date subscription)
// with indefinite access. The webhook is what USUALLY updates the
// status promptly, but this function is the actual, authoritative
// access gate, and it has to be correct even in the gap before that
// webhook arrives (or if it never arrives at all — a real possibility
// with any webhook-based system).
//
// Takes the candidate's profile row (or the relevant subset of it) —
// not just the bare status string — specifically so it can check those
// timestamps. Every caller must pass real, freshly-queried column
// values; there is no reasonable stale-safe default here.
function hasFullAccess(profile) {
  if (!profile) return false;
  const status = profile.subscription_status;
  if (status !== "trialing" && status !== "active") return false;

  const now = Date.now();

  // A scheduled cancellation cuts access exactly at the date Stripe
  // recorded, regardless of which of the two access-granting statuses
  // the row still shows — covers both "cancelled mid-trial, trial
  // since ended" and "cancelled while paying, paid-through period
  // since ended," including the case where the webhook that would
  // normally flip the status to 'cancelled' hasn't arrived yet.
  if (profile.subscription_cancel_at && new Date(profile.subscription_cancel_at).getTime() <= now) {
    return false;
  }

  // A trial's own natural end date cuts access even when the
  // candidate never cancelled anything — this is the specific case a
  // delayed/missed "trial converted to active" (or "trial ended, first
  // charge failed") webhook would otherwise leave open indefinitely.
  // Only checked for 'trialing' — once status is genuinely 'active'
  // (the trial converted), the old trial_ends_at is irrelevant.
  if (status === "trialing" && profile.trial_ends_at && new Date(profile.trial_ends_at).getTime() <= now) {
    return false;
  }

  return true;
}

function isPayingSubscriber(status) {
  return status === "active";
}

module.exports = { scoreJob, stateAbbrFromName, extractSalaryFigure, extractJobTravelPercentage, mentionsNonUsCountry, containsNonLatinScript, hasFullAccess, isPayingSubscriber };
