// Matching engine — now using AI-derived résumé and job analysis, split
// into the three-score model Gene's spec called for: Candidate Fit
// ("can you do this job"), Preference Fit ("does this match what you
// said you want"), and an Overall Recommendation combining both, plus a
// four-bucket recommendation label (Strong Apply / Apply / Stretch Apply
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
  "shanghai", "beijing", "shenzhen", "guangzhou", "manila", "jakarta",
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
function mentionsNonUsCountry(locationRaw, jobLng) {
  if (jobLng != null && jobLng > 0) return true;
  if (!locationRaw) return false;
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
  if (score >= 90) return "Strong Apply";
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
 *   recommendation: "Strong Apply"|"Apply"|"Stretch Apply"|"Skip"|null,
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
  // PREFERENCE FIT — would the candidate want this job
  // ============================================================

  // --- Location (up to 35 points) ---
  //
  // Distance is now the PRIMARY signal when both sides have real
  // coordinates — state matching is only a FALLBACK for when a ZIP or a
  // job's coordinates aren't available yet (common early on, or for
  // messy job-location text that fails to geocode). State boundaries
  // are an administrative convenience, not a real proxy for how far a
  // job actually is — someone near the FL/GA border could have a job
  // just across the state line that's genuinely closer than one on the
  // far side of their own state, and treating that as a hard
  // disqualifier (as the state-only version of this did) was a real,
  // reported flaw, not a hypothetical one.
  prefMax += 35;
  dataPointsPossible++;
  const _locPrefBefore = prefScore;

  // A candidate can accept jobs from their home state AND any additional
  // states they've explicitly said they want to see (preferred_states).
  // In the distance-primary path below, this set no longer gates
  // location outright — it's what keeps a genuinely FAR job from being a
  // hard disqualifier if it's somewhere the candidate said they're open
  // to (or willing to relocate for), rather than being the main signal.
  const acceptedStateAbbrs = new Set();
  const homeStateAbbr = stateAbbrFromName(profile.home_state);
  if (homeStateAbbr) acceptedStateAbbrs.add(homeStateAbbr);
  for (const s of profile.preferred_states || []) {
    const abbr = stateAbbrFromName(s);
    if (abbr) acceptedStateAbbrs.add(abbr);
  }
  if (acceptedStateAbbrs.size > 0) dataPointsAvailable++;

  // Remote no longer bypasses distance scoring. Direct correction from
  // industry experience: in field/outside sales, "remote" means "no
  // office to report to," not "location doesn't matter" — a "Remote —
  // North Carolina" posting is still tied to a real NC territory. The
  // previous version gave every remote-labeled job a flat 28/35 points
  // regardless of actual distance, which is exactly why unrelated jobs
  // in NC, Michigan, and CA were all scoring similarly high for a
  // Florida candidate — the real distance was never being considered at
  // all. Now every job with real coordinates goes through the same
  // distance-primary scoring below, remote or not; "remote" is kept as
  // a purely informational callout, not a score input.
  const isRemoteLabeled = /remote/i.test(job.location_raw || "") || job.remote_status === "remote";
  const mentionsForeignCountry = mentionsNonUsCountry(job.location_raw, job.job_lng);

  const hasRealCoordinates = profile.home_lat != null && profile.home_lng != null && job.job_lat != null && job.job_lng != null;

  if (mentionsForeignCountry) {
    concerns.push(`Location (${job.location_raw}) appears to be outside the United States`);
    hardDisqualifier = true;
    prefCap = Math.min(prefCap, 65);
  } else if (hasRealCoordinates) {
    // --- Distance-primary path ---
    dataPointsAvailable++; // this data point (real coordinates) was actually available
    const miles = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
    const jobStateAbbr = [...acceptedStateAbbrs].find((abbr) => locationMentionsState(job.location_raw, abbr))
      || Object.values(STATE_ABBR).find((abbr) => locationMentionsState(job.location_raw, abbr));
    const inAcceptedRegion = acceptedStateAbbrs.size === 0 || [...acceptedStateAbbrs].some((abbr) => locationMentionsState(job.location_raw, abbr));

    if (miles <= 60) {
      // Direct instruction: within 60 miles is the new "full credit"
      // zone (tightened from the previous 90-mile threshold) — a
      // genuinely comfortable commute/territory distance for field
      // sales, and forces the Location & Preferences category label
      // itself to "Strong" — not just a high number feeding into a
      // blended ratio that compensation or travel-% mismatches could
      // still drag down below the "Strong" threshold.
      locationForcedStrong = true;
      prefScore += 35;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 90) {
      prefScore += 28;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 120) {
      prefScore += 22;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 150) {
      prefScore += 17;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 300) {
      prefScore += 10;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (inAcceptedRegion || profile.willing_to_relocate) {
      // Genuinely far, but somewhere the candidate said they're open to
      // (an accepted state/region) or willing to relocate for — real
      // partial credit, not a hard disqualifier, but deliberately small
      // now that the curve step-down is more gradual leading up to it.
      //
      // Direct instruction: a job this far out should score 50% AT
      // BEST overall, regardless of how well it does on every other
      // category — being in an "accepted region" earns it a real
      // partial location score instead of an automatic disqualifying
      // Gap, but it should never let a strong candidate/preference fit
      // elsewhere pull the OVERALL score up past that ceiling the way
      // the previous version allowed (a 746-mile job could still land
      // at 76% overall on the strength of other categories). This caps
      // overall_score itself, the same mechanism already used for the
      // hard-disqualifier cases below, not just the location sub-score.
      prefScore += 5;
      overallCap = Math.min(overallCap, 50);
      reasons.push(
        profile.willing_to_relocate
          ? "Far from you, but you've indicated openness to relocation"
          : "Far from you, but within a region you said you're open to"
      );
    } else {
      concerns.push(`Location (${job.location_raw}, about ${Math.round(miles)} miles away) is far outside your area and not in a region you've said you're open to`);
      hardDisqualifier = true;
      prefCap = Math.min(prefCap, 65);
      // Belt-and-suspenders with the overallCap mechanism above, rather
      // than relying solely on the hardDisqualifier-gated cap further
      // down - keeps both far-distance branches using the same,
      // unconditional final-score ceiling instead of two different
      // capping mechanisms that are easy to lose track of.
      overallCap = Math.min(overallCap, 65);
    }
  } else if (acceptedStateAbbrs.size > 0 && [...acceptedStateAbbrs].some((abbr) => locationMentionsState(job.location_raw, abbr))) {
    // --- Fallback: no real coordinates on one or both sides, so fall
    // back to state-matching. Reasonable when a ZIP hasn't been set yet,
    // or a job's location text failed to geocode.
    //
    // IMPORTANT: this deliberately does NOT award full credit. It used
    // to award the same as a confirmed close-distance match, which
    // created a real, reported inconsistency — an ungeocoded same-state
    // job (full credit, distance genuinely unknown) could outrank a
    // geocoded job confirmed to be much closer. Matching within a state
    // is real information, worth more than nothing, but never worth
    // MORE than a distance that's actually been verified — 19 points
    // sits deliberately between the confirmed 120-mile tier (22) and
    // 150-mile tier (17), reflecting genuine "somewhere in this state,
    // exact distance unknown" uncertainty.
    const matchedAbbr = [...acceptedStateAbbrs].find((abbr) => locationMentionsState(job.location_raw, abbr));
    prefScore += 19;
    reasons.push(
      matchedAbbr === homeStateAbbr
        ? "Location matches your home state (exact distance not yet available for this job)"
        : `Location matches one of your preferred states (${matchedAbbr}) — exact distance not yet available`
    );
  } else if (profile.willing_to_relocate) {
    prefScore += 14;
    reasons.push("You've indicated openness to relocation");
  } else if (acceptedStateAbbrs.size > 0 && job.location_raw) {
    concerns.push(`Location (${job.location_raw}) may be outside your preferred states`);
    hardDisqualifier = true;
    prefCap = Math.min(prefCap, 65);
  }

  // Purely informational — does not add or remove points. Being able to
  // work from home has real value to a candidate, it's just not the
  // same thing as "distance doesn't matter," which is what this used to
  // mean before the fix above.
  if (isRemoteLabeled && !mentionsForeignCountry) {
    reasons.push("Remote-friendly role");
  }

  cat.location_prefs.max += 35;
  cat.location_prefs.score += (prefScore - _locPrefBefore);
  if (hardDisqualifier && prefCap <= 65) catGap.add("location_prefs");

  // --- Compensation (up to 30 points) ---
  prefMax += 30;
  dataPointsPossible++;
  const _compBefore = prefScore;
  const jobSalary = extractSalaryFigure(job);
  if (jobSalary) dataPointsAvailable++;

  if (profile.minimum_base_salary && jobSalary) {
    if (jobSalary >= profile.minimum_base_salary) {
      prefScore += 30;
      reasons.push("Compensation meets your stated minimum");
    } else if (jobSalary >= profile.minimum_base_salary * 0.85) {
      prefScore += 13;
      concerns.push("Compensation may be slightly below your stated minimum");
    } else {
      prefScore += 4;
      concerns.push("Compensation appears well below your stated minimum");
      hardDisqualifier = true;
      prefCap = Math.min(prefCap, 55);
    }
  } else if (jobSalary) {
    prefScore += 18;
  } else {
    prefScore += 15;
  }

  cat.location_prefs.max += 30;
  cat.location_prefs.score += (prefScore - _compBefore);
  if (hardDisqualifier && prefCap <= 55) catGap.add("location_prefs");

  // --- Travel fit (up to 12 points) ---
  const jobTravel = extractJobTravelPercentage(job);
  const _travelBefore = prefScore;
  if (profile.maximum_travel_percentage != null && jobTravel != null) {
    prefMax += 12;
    dataPointsPossible++;
    dataPointsAvailable++;
    if (jobTravel <= profile.maximum_travel_percentage) {
      prefScore += 12;
      reasons.push(`Travel (${jobTravel}%) is within your stated limit`);
    } else if (jobTravel <= profile.maximum_travel_percentage + 15) {
      prefScore += 5;
      concerns.push(`Travel (${jobTravel}%) is somewhat above your stated limit`);
    } else {
      concerns.push(`Travel (${jobTravel}%) is well above your stated limit`);
    }
  }

  cat.location_prefs.max += 12;
  cat.location_prefs.score += Math.max(0, prefScore - _travelBefore);

  // --- Onboarding-stated industry interest (up to 15 points) ---
  const _indInterestBefore = prefScore;
  if (Array.isArray(profile.desired_industries) && profile.desired_industries.length > 0) {
    prefMax += 15;
    dataPointsPossible++;
    dataPointsAvailable++;
    const jobText = `${job.title_original || ""} ${job.description_text || ""}`.toLowerCase();
    // Reported directly, with a concrete case: "Veterinary / Animal
    // Health" as a whole never matches ordinary job text, since no
    // real posting phrases it as that exact compound string with a
    // slash — a description that says "veterinary clinics" or "animal
    // health customers" (this job's own AI-extracted customer type was
    // literally "Veterinarians") was silently scoring zero on stated
    // industry interest. Splits each chip on "/" and other separators
    // so "Veterinary / Animal Health" checks for "veterinary" OR
    // "animal health" independently — the other four industry chips
    // (Diagnostics, Medical Device, Capital Equipment, Pharmaceutical)
    // are single terms already and are unaffected by this change.
    const matchedIndustry = profile.desired_industries.find((ind) =>
      String(ind)
        .toLowerCase()
        .split(/\s*[\/,&]\s*/)
        .filter(Boolean)
        .some((term) => jobText.includes(term))
    );
    if (matchedIndustry) {
      prefScore += 15;
      reasons.push(`Matches your stated interest in ${matchedIndustry}`);
    }
    if (Array.isArray(profile.industries_to_avoid) && profile.industries_to_avoid.length > 0) {
      // Same bug class as the desired-industries fix above, and
      // arguably worse here: a compound avoided-industry value silently
      // failing to match means the candidate never gets warned about
      // something they explicitly asked to avoid, rather than just
      // under-scoring a good match.
      const avoided = profile.industries_to_avoid.find((ind) =>
        String(ind)
          .toLowerCase()
          .split(/\s*[\/,&]\s*/)
          .filter(Boolean)
          .some((term) => jobText.includes(term))
      );
      if (avoided) concerns.push(`Mentions ${avoided}, which you asked to avoid`);
    }
  }

  cat.industry_product.max += 15;
  cat.industry_product.score += (prefScore - _indInterestBefore);

  // --- Job freshness (up to 8 points) ---
  prefMax += 8;
  const referenceDate = job.last_seen_at || job.date_posted;
  if (referenceDate) {
    const ageDays = (Date.now() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 3) {
      prefScore += 8;
      reasons.push("Posted or verified in the last few days");
    } else if (ageDays <= 14) {
      prefScore += 5;
    } else if (ageDays <= 30) {
      prefScore += 2;
    }
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
      cat.industry_product.max += 25;
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
        reasons.push(`Your ${matchedMotion} sales experience matches this role's style`);
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
      const matchedSpecialty = findOverlap(jobSpecialties, resumeSpecialties);
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
      const unmet = mandatoryClinical.find(
        (req) => !resumeClinicalText.includes(String(req.requirement).toLowerCase().split(" ")[0])
      );
      if (unmet) {
        concerns.push(`Job requires "${unmet.requirement}" — not clearly shown on your résumé`);
        hardDisqualifier = true;
        candCap = Math.min(candCap, 60);
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

  let overall_score;
  if (candidate_fit != null && preference_fit != null) {
    overall_score = Math.round((candidate_fit + preference_fit) / 2);
  } else if (candidate_fit != null) {
    overall_score = candidate_fit;
  } else if (preference_fit != null) {
    overall_score = preference_fit;
  } else {
    overall_score = null;
  }
  if (hardDisqualifier && overall_score != null) {
    overall_score = Math.min(overall_score, Math.min(prefCap, candCap));
  }
  if (overall_score != null) {
    overall_score = Math.min(overall_score, overallCap);
  }

  const availabilityRatio = dataPointsPossible > 0 ? dataPointsAvailable / dataPointsPossible : 0;
  const confidence = availabilityRatio >= 0.75 ? "high" : availabilityRatio >= 0.4 ? "medium" : "low";

  // --- Excellent Match determination (backs the 30-day guarantee) ---
  // Deliberately stricter than just "overall_score >= 90" — scoring 90%
  // on preference-fit alone with no résumé/job-AI data at all would
  // otherwise qualify, which isn't a real "excellent match," it's an
  // absence of information. Every category that has data must clear its
  // bar, and any category with no data (rating === null) fails the
  // requirement rather than being ignored, since the guarantee shouldn't
  // be gameable by incomplete candidate/job data.
  const goodOrStrong = (r) => r === "Strong" || r === "Good";
  const excellent_match = Boolean(
    overall_score != null &&
    overall_score >= 90 &&
    !hardDisqualifier &&
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

module.exports = { scoreJob, stateAbbrFromName, extractSalaryFigure, extractJobTravelPercentage, mentionsNonUsCountry };
