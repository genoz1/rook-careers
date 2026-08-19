// Matching engine — Phase 1 slice, expanded.
//
// Gene provided a genuinely comprehensive 50-factor matching spec (three
// layers: hard disqualifiers, weighted fit score, confidence score; plus
// separate Candidate Fit / Preference Fit / Overall Recommendation
// scores). This file implements the realistic subset of that spec
// buildable with data ROOK already has — it is NOT the full spec.
//
// Implemented here: location, compensation, industry interest, travel
// fit, job freshness, hard-disqualifier score capping, and an explicit
// confidence rating.
//
// Explicitly NOT implemented, and why — these need infrastructure that
// doesn't exist yet:
//   - Industry/product/clinical/specialty experience matching (factors
//     2-9, 23) — needs résumé parsing. Nothing currently reads what's
//     inside an uploaded résumé; only self-reported onboarding chips.
//   - Requirement-strength classification — Mandatory vs. Preferred vs.
//     Boilerplate (factor 28) — needs a real AI/LLM call per job
//     posting, which costs money and adds latency to ingestion.
//   - Semantic matching (factor 46) — needs embeddings (pgvector column
//     already exists in the schema, nothing populates or queries it yet).
//   - Feedback loop / outcome learning (factors 48-49) — needs real
//     usage data accumulated over time, which can't exist before real
//     candidates are using the product.
//   - Separate Candidate Fit / Preference Fit / Overall Recommendation
//     triple-score — collapsed into one overall_score for now; splitting
//     it out is a reasonable next step once there's demand for it.
//
// Also worth knowing: no job adapter currently populates the jobs.city /
// jobs.state columns — they only set location_raw as free text (e.g.
// "Orlando, FL" or "Columbus, OH (US)"). So this module does its own
// lightweight state-abbreviation matching against location_raw rather
// than relying on a structured state column that's actually empty.

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

/**
 * Score one job against one candidate profile.
 *
 * @param {object} job - a row from the jobs table
 * @param {object} profile - a row from the candidate_profiles table
 * @returns {{
 *   overall_score: number|null,
 *   reasons: string[],
 *   concerns: string[],
 *   confidence: "high"|"medium"|"low",
 *   hard_disqualifier: boolean
 * }}
 */
function scoreJob(job, profile) {
  const reasons = [];
  const concerns = [];
  let score = 0;
  let maxScore = 0;
  let dataPointsAvailable = 0;
  let dataPointsPossible = 0;
  let hardDisqualifier = false;
  let disqualifierCap = 100;

  // --- Location (up to 40 points) ---
  maxScore += 40;
  dataPointsPossible++;
  const remoteFriendly = /remote/i.test(job.location_raw || "") || job.remote_status === "remote";
  const candidateStateAbbr = stateAbbrFromName(profile.home_state);
  if (candidateStateAbbr) dataPointsAvailable++;

  if (candidateStateAbbr && locationMentionsState(job.location_raw, candidateStateAbbr)) {
    score += 40;
    reasons.push("Location matches your home state");
  } else if (remoteFriendly) {
    score += 32;
    reasons.push("Remote-friendly role");
  } else if (profile.willing_to_relocate) {
    score += 16;
    reasons.push("You've indicated openness to relocation");
  } else if (candidateStateAbbr && job.location_raw) {
    concerns.push(`Location (${job.location_raw}) may be outside your home state`);
    if (!remoteFriendly) {
      hardDisqualifier = true;
      disqualifierCap = Math.min(disqualifierCap, 65);
    }
  }

  // --- Compensation (up to 35 points) ---
  maxScore += 35;
  dataPointsPossible++;
  const jobSalary = extractSalaryFigure(job);
  if (jobSalary) dataPointsAvailable++;

  if (profile.minimum_base_salary && jobSalary) {
    if (jobSalary >= profile.minimum_base_salary) {
      score += 35;
      reasons.push("Compensation meets your stated minimum");
    } else if (jobSalary >= profile.minimum_base_salary * 0.85) {
      score += 15;
      concerns.push("Compensation may be slightly below your stated minimum");
    } else {
      score += 5;
      concerns.push("Compensation appears well below your stated minimum");
      hardDisqualifier = true;
      disqualifierCap = Math.min(disqualifierCap, 55);
    }
  } else if (jobSalary) {
    score += 22;
  } else {
    score += 18;
  }

  // --- Travel fit (up to 15 points) ---
  const jobTravel = extractJobTravelPercentage(job);
  if (profile.maximum_travel_percentage != null && jobTravel != null) {
    maxScore += 15;
    dataPointsPossible++;
    dataPointsAvailable++;
    if (jobTravel <= profile.maximum_travel_percentage) {
      score += 15;
      reasons.push(`Travel (${jobTravel}%) is within your stated limit`);
    } else if (jobTravel <= profile.maximum_travel_percentage + 15) {
      score += 6;
      concerns.push(`Travel (${jobTravel}%) is somewhat above your stated limit`);
    } else {
      concerns.push(`Travel (${jobTravel}%) is well above your stated limit`);
    }
  }

  // --- Industry interest (up to 20 points) ---
  if (Array.isArray(profile.desired_industries) && profile.desired_industries.length > 0) {
    maxScore += 20;
    dataPointsPossible++;
    dataPointsAvailable++;
    const jobText = `${job.title_original || ""} ${job.description_text || ""}`.toLowerCase();
    const matchedIndustry = profile.desired_industries.find((ind) => jobText.includes(String(ind).toLowerCase()));
    if (matchedIndustry) {
      score += 20;
      reasons.push(`Matches your interest in ${matchedIndustry}`);
    }

    if (Array.isArray(profile.industries_to_avoid) && profile.industries_to_avoid.length > 0) {
      const avoided = profile.industries_to_avoid.find((ind) => jobText.includes(String(ind).toLowerCase()));
      if (avoided) {
        concerns.push(`Mentions ${avoided}, which you asked to avoid`);
      }
    }
  }

  // --- Job freshness (up to 10 points) ---
  maxScore += 10;
  const referenceDate = job.last_seen_at || job.date_posted;
  if (referenceDate) {
    const ageDays = (Date.now() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 3) {
      score += 10;
      reasons.push("Posted or verified in the last few days");
    } else if (ageDays <= 14) {
      score += 6;
    } else if (ageDays <= 30) {
      score += 3;
    }
  }

  let overall_score = maxScore > 0 ? Math.round((score / maxScore) * 100) : null;
  if (hardDisqualifier && overall_score != null) {
    overall_score = Math.min(overall_score, disqualifierCap);
  }

  const availabilityRatio = dataPointsPossible > 0 ? dataPointsAvailable / dataPointsPossible : 0;
  const confidence = availabilityRatio >= 0.75 ? "high" : availabilityRatio >= 0.4 ? "medium" : "low";

  return { overall_score, reasons, concerns, confidence, hard_disqualifier: hardDisqualifier };
}

module.exports = { scoreJob, stateAbbrFromName, extractSalaryFigure, extractJobTravelPercentage };
