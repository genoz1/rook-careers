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
];
function mentionsNonUsCountry(locationRaw) {
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

function findOverlap(listA, listB) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) return null;
  const setB = listB.map((s) => String(s).toLowerCase());
  return listA.find((a) => setB.includes(String(a).toLowerCase())) || null;
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

  // A location string is only treated as genuinely remote-friendly if it
  // doesn't also name a specific state/country — see
  // mentionsADifferentState's comment for why ("California... - Remote"
  // almost always means remote-within-California, not nationwide).
  // Remote is checked first and short-circuits distance entirely, since
  // a genuinely remote role has no meaningful commute distance.
  const mentionsOtherState = mentionsADifferentState(job.location_raw, acceptedStateAbbrs);
  const mentionsForeignCountry = mentionsNonUsCountry(job.location_raw);
  const remoteFriendly = (/remote/i.test(job.location_raw || "") || job.remote_status === "remote") && !mentionsOtherState && !mentionsForeignCountry;

  const hasRealCoordinates = profile.home_lat != null && profile.home_lng != null && job.job_lat != null && job.job_lng != null;

  if (remoteFriendly) {
    prefScore += 28;
    reasons.push("Remote-friendly role");
  } else if (hasRealCoordinates) {
    // --- Distance-primary path ---
    dataPointsAvailable++; // this data point (real coordinates) was actually available
    const miles = distanceMiles(profile.home_lat, profile.home_lng, job.job_lat, job.job_lng);
    const jobStateAbbr = [...acceptedStateAbbrs].find((abbr) => locationMentionsState(job.location_raw, abbr))
      || Object.values(STATE_ABBR).find((abbr) => locationMentionsState(job.location_raw, abbr));
    const inAcceptedRegion = acceptedStateAbbrs.size === 0 || [...acceptedStateAbbrs].some((abbr) => locationMentionsState(job.location_raw, abbr));

    if (miles <= 25) {
      prefScore += 35;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 75) {
      prefScore += 30;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 150) {
      prefScore += 22;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (miles <= 300) {
      prefScore += 14;
      reasons.push(`About ${Math.round(miles)} miles from you`);
    } else if (inAcceptedRegion || profile.willing_to_relocate) {
      // Genuinely far, but somewhere the candidate said they're open to
      // (an accepted state/region) or willing to relocate for — real
      // partial credit, not a hard disqualifier.
      prefScore += 8;
      reasons.push(
        profile.willing_to_relocate
          ? "Far from you, but you've indicated openness to relocation"
          : "Far from you, but within a region you said you're open to"
      );
    } else {
      concerns.push(`Location (${job.location_raw}, about ${Math.round(miles)} miles away) is far outside your area and not in a region you've said you're open to`);
      hardDisqualifier = true;
      prefCap = Math.min(prefCap, 65);
    }
  } else if (acceptedStateAbbrs.size > 0 && [...acceptedStateAbbrs].some((abbr) => locationMentionsState(job.location_raw, abbr))) {
    // --- Fallback: no real coordinates on one or both sides, so fall
    // back to the state-matching logic this replaced as the primary
    // signal. Reasonable when a ZIP hasn't been set yet, or a job's
    // location text failed to geocode.
    const matchedAbbr = [...acceptedStateAbbrs].find((abbr) => locationMentionsState(job.location_raw, abbr));
    prefScore += 35;
    reasons.push(
      matchedAbbr === homeStateAbbr
        ? "Location matches your home state"
        : `Location matches one of your preferred states (${matchedAbbr})`
    );
  } else if (profile.willing_to_relocate) {
    prefScore += 14;
    reasons.push("You've indicated openness to relocation");
  } else if (acceptedStateAbbrs.size > 0 && job.location_raw) {
    concerns.push(`Location (${job.location_raw}) may be outside your preferred states`);
    hardDisqualifier = true;
    prefCap = Math.min(prefCap, 65);
  }

  // --- Compensation (up to 30 points) ---
  prefMax += 30;
  dataPointsPossible++;
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

  // --- Travel fit (up to 12 points) ---
  const jobTravel = extractJobTravelPercentage(job);
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

  // --- Onboarding-stated industry interest (up to 15 points) ---
  if (Array.isArray(profile.desired_industries) && profile.desired_industries.length > 0) {
    prefMax += 15;
    dataPointsPossible++;
    dataPointsAvailable++;
    const jobText = `${job.title_original || ""} ${job.description_text || ""}`.toLowerCase();
    const matchedIndustry = profile.desired_industries.find((ind) => jobText.includes(String(ind).toLowerCase()));
    if (matchedIndustry) {
      prefScore += 15;
      reasons.push(`Matches your stated interest in ${matchedIndustry}`);
    }
    if (Array.isArray(profile.industries_to_avoid) && profile.industries_to_avoid.length > 0) {
      const avoided = profile.industries_to_avoid.find((ind) => jobText.includes(String(ind).toLowerCase()));
      if (avoided) concerns.push(`Mentions ${avoided}, which you asked to avoid`);
    }
  }

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
    candMax += 25;
    dataPointsPossible++;
    const resumeIndustries = (resume.industries_experience || []).map((i) => i.industry);
    if (resumeIndustries.length > 0) dataPointsAvailable++;

    const matchedRequired = findOverlap(jobAI.required_industries, resumeIndustries);
    const matchedPreferred = findOverlap(jobAI.preferred_industries, resumeIndustries);
    if (matchedRequired) {
      candScore += 25;
      reasons.push(`Your ${matchedRequired} experience matches a required industry`);
    } else if (matchedPreferred) {
      candScore += 16;
      reasons.push(`Your ${matchedPreferred} experience matches a preferred industry`);
    } else if (Array.isArray(jobAI.required_industries) && jobAI.required_industries.length > 0) {
      concerns.push(`Job requires industry experience (${jobAI.required_industries.join(", ")}) not found on your résumé`);
      hardDisqualifier = true;
      candCap = Math.min(candCap, 70);
    } else {
      candScore += 10;
    }

    // --- AI product-category match (up to 18 points, spec factor #3) ---
    candMax += 18;
    dataPointsPossible++;
    const resumeProducts = resume.product_categories || [];
    if (resumeProducts.length > 0) dataPointsAvailable++;
    const matchedProduct = findOverlap(jobAI.product_categories, resumeProducts);
    if (matchedProduct) {
      candScore += 18;
      reasons.push(`You have direct ${matchedProduct} product experience`);
    } else {
      candScore += 8;
    }

    // --- AI customer/call-point match (up to 18 points, spec factor #4) ---
    candMax += 18;
    dataPointsPossible++;
    const resumeCustomers = resume.customer_types || [];
    if (resumeCustomers.length > 0) dataPointsAvailable++;
    const matchedCustomer = findOverlap(jobAI.required_customer_types, resumeCustomers);
    if (matchedCustomer) {
      candScore += 18;
      reasons.push(`You've sold to ${matchedCustomer} before`);
    } else {
      candScore += 8;
    }

    // --- AI seniority fit (up to 12 points, spec factor #6) ---
    if (resume.seniority_level && jobAI.seniority_level) {
      candMax += 12;
      dataPointsPossible++;
      dataPointsAvailable++;
      if (resume.seniority_level.toLowerCase() === jobAI.seniority_level.toLowerCase()) {
        candScore += 12;
        reasons.push(`Seniority level (${jobAI.seniority_level}) matches your background`);
      } else {
        candScore += 5;
      }
    }

    // --- Sales-motion fit (up to 10 points, spec factor #5) ---
    const resumeMotion = resume.sales_motion || [];
    const jobMotion = jobAI.sales_motion || [];
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

    // --- Required years of experience (up to 10 points, spec factor #7) ---
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

    // --- Specialty experience (up to 8 points, spec factor #9) ---
    const resumeSpecialties = resume.specialties || [];
    const jobSpecialties = jobAI.specialty_requirements || [];
    if (jobSpecialties.length > 0) {
      candMax += 8;
      dataPointsPossible++;
      if (resumeSpecialties.length > 0) dataPointsAvailable++;
      const matchedSpecialty = findOverlap(jobSpecialties, resumeSpecialties);
      if (matchedSpecialty) {
        candScore += 8;
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
      reasons.push("Résumé shows documented sales performance achievements");
    }

    // --- Certifications/licensing (up to 5 points, spec factor #15) ---
    const resumeCerts = resume.certifications || [];
    if (resumeCerts.length > 0) {
      candMax += 5;
      dataPointsPossible++;
      dataPointsAvailable++;
      candScore += 5;
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
      }
    }
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

  const availabilityRatio = dataPointsPossible > 0 ? dataPointsAvailable / dataPointsPossible : 0;
  const confidence = availabilityRatio >= 0.75 ? "high" : availabilityRatio >= 0.4 ? "medium" : "low";

  return {
    candidate_fit,
    preference_fit,
    overall_score,
    recommendation: recommendationForScore(overall_score),
    reasons,
    concerns,
    confidence,
    hard_disqualifier: hardDisqualifier,
  };
}

module.exports = { scoreJob, stateAbbrFromName, extractSalaryFigure, extractJobTravelPercentage };
