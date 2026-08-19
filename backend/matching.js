// Matching engine — now using AI-derived résumé and job analysis.
//
// This extends the earlier deterministic-only version (location,
// compensation, travel, onboarding-stated industry interest, freshness)
// with real comparison against AI-extracted structured data: a
// candidate's résumé analysis (backend/ai/resumeAnalysis.js) and a job's
// requirement analysis (backend/ai/jobAnalysis.js). Both are optional —
// a job or profile without AI analysis yet still scores correctly on the
// deterministic factors alone, same "don't penalize missing data"
// philosophy as before.
//
// Factors implemented from Gene's 50-factor spec: geography (#1),
// industry experience (#2), product category (#3), customer/call-point
// (#4), sales motion (#5), seniority (#6), years of experience (#7),
// clinical hard requirement (#8, partial), specialty experience (#9),
// performance history (#10, partial), compensation (#12), certifications
// (#15, partial), travel (#18, partial), job freshness (#38), missing-
// data confidence (#47).
//
// Still NOT implemented from the full spec:
//   - True semantic matching (#46) — this module does categorized
//     KEYWORD overlap ("Diagnostics" = "Diagnostics"), not genuine
//     semantic understanding ("reference lab experience" ≈ "diagnostic
//     services"). Real semantic matching needs embeddings — the schema's
//     pgvector column exists, nothing populates or queries it yet.
//   - Existing relationships/network (#11), employment type (#13),
//     education (#14), company type/size (#16-17), role responsibilities
//     (#20), required tools (#21), competitive-company experience (#22),
//     transferability (#23), recency weighting (#24), duration/stability
//     (#25), career trajectory (#26), résumé evidence strength (#27) —
//     none captured or scored yet
//   - Overqualification/stretch-apply labeling (#33-34)
//   - Separate employer-interest vs candidate-interest scores (#35-36)
//   - Opportunity quality, application friction (#37, #39)
//   - Duplicate/reposted-job detection (#40-41)
//   - Application/employer history awareness (#42-43) — no applications
//     backend exists at all yet
//   - Network opportunity (#44)
//   - Feedback loop, outcome learning (#48-49) — needs real usage data
//     accumulated over time, which can't exist before real candidates
//     are using the product
//   - The three-way Candidate Fit / Preference Fit / Overall
//     Recommendation split and four-bucket recommendation labels (Strong
//     Apply / Apply / Stretch Apply / Skip) — still one combined
//     overall_score
//
// Also worth knowing: no job adapter populates jobs.city/jobs.state —
// only location_raw free text — so this module does its own lightweight
// state-abbreviation matching rather than relying on structured columns
// that are actually empty.

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

// Case-insensitive overlap check between two string lists.
function findOverlap(listA, listB) {
  if (!Array.isArray(listA) || !Array.isArray(listB)) return null;
  const setB = listB.map((s) => String(s).toLowerCase());
  return listA.find((a) => setB.includes(String(a).toLowerCase())) || null;
}

// pgvector columns can come back from Supabase as either a real JS array
// or a string like "[0.1,0.2,...]" depending on client/driver version —
// handle both.
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

/**
 * Score one job against one candidate profile.
 *
 * @param {object} job - a row from the jobs table (may include ai_analysis)
 * @param {object} profile - a row from candidate_profiles (may include resume_structured)
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

  // --- Location (up to 35 points) ---
  maxScore += 35;
  dataPointsPossible++;
  const remoteFriendly = /remote/i.test(job.location_raw || "") || job.remote_status === "remote";
  const candidateStateAbbr = stateAbbrFromName(profile.home_state);
  if (candidateStateAbbr) dataPointsAvailable++;

  if (candidateStateAbbr && locationMentionsState(job.location_raw, candidateStateAbbr)) {
    score += 35;
    reasons.push("Location matches your home state");
  } else if (remoteFriendly) {
    score += 28;
    reasons.push("Remote-friendly role");
  } else if (profile.willing_to_relocate) {
    score += 14;
    reasons.push("You've indicated openness to relocation");
  } else if (candidateStateAbbr && job.location_raw) {
    concerns.push(`Location (${job.location_raw}) may be outside your home state`);
    if (!remoteFriendly) {
      hardDisqualifier = true;
      disqualifierCap = Math.min(disqualifierCap, 65);
    }
  }

  // --- Compensation (up to 30 points) ---
  maxScore += 30;
  dataPointsPossible++;
  const jobSalary = extractSalaryFigure(job);
  if (jobSalary) dataPointsAvailable++;

  if (profile.minimum_base_salary && jobSalary) {
    if (jobSalary >= profile.minimum_base_salary) {
      score += 30;
      reasons.push("Compensation meets your stated minimum");
    } else if (jobSalary >= profile.minimum_base_salary * 0.85) {
      score += 13;
      concerns.push("Compensation may be slightly below your stated minimum");
    } else {
      score += 4;
      concerns.push("Compensation appears well below your stated minimum");
      hardDisqualifier = true;
      disqualifierCap = Math.min(disqualifierCap, 55);
    }
  } else if (jobSalary) {
    score += 18;
  } else {
    score += 15;
  }

  // --- Travel fit (up to 12 points) ---
  const jobTravel = extractJobTravelPercentage(job);
  if (profile.maximum_travel_percentage != null && jobTravel != null) {
    maxScore += 12;
    dataPointsPossible++;
    dataPointsAvailable++;
    if (jobTravel <= profile.maximum_travel_percentage) {
      score += 12;
      reasons.push(`Travel (${jobTravel}%) is within your stated limit`);
    } else if (jobTravel <= profile.maximum_travel_percentage + 15) {
      score += 5;
      concerns.push(`Travel (${jobTravel}%) is somewhat above your stated limit`);
    } else {
      concerns.push(`Travel (${jobTravel}%) is well above your stated limit`);
    }
  }

  // --- Onboarding-stated industry interest (up to 15 points) ---
  if (Array.isArray(profile.desired_industries) && profile.desired_industries.length > 0) {
    maxScore += 15;
    dataPointsPossible++;
    dataPointsAvailable++;
    const jobText = `${job.title_original || ""} ${job.description_text || ""}`.toLowerCase();
    const matchedIndustry = profile.desired_industries.find((ind) => jobText.includes(String(ind).toLowerCase()));
    if (matchedIndustry) {
      score += 15;
      reasons.push(`Matches your stated interest in ${matchedIndustry}`);
    }
    if (Array.isArray(profile.industries_to_avoid) && profile.industries_to_avoid.length > 0) {
      const avoided = profile.industries_to_avoid.find((ind) => jobText.includes(String(ind).toLowerCase()));
      if (avoided) concerns.push(`Mentions ${avoided}, which you asked to avoid`);
    }
  }

  // --- Job freshness (up to 8 points) ---
  maxScore += 8;
  const referenceDate = job.last_seen_at || job.date_posted;
  if (referenceDate) {
    const ageDays = (Date.now() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 3) {
      score += 8;
      reasons.push("Posted or verified in the last few days");
    } else if (ageDays <= 14) {
      score += 5;
    } else if (ageDays <= 30) {
      score += 2;
    }
  }

  // ============================================================
  // AI-derived factors — only scored when BOTH the candidate's résumé
  // analysis AND the job's requirement analysis exist. This is the real
  // upgrade from résumé parsing: actual industry/product/customer-type/
  // seniority comparison instead of onboarding self-report alone.
  // ============================================================
  const resume = profile.resume_structured;
  const jobAI = job.ai_analysis;

  if (resume && jobAI) {
    // --- AI industry experience match (up to 25 points, spec factor #2) ---
    maxScore += 25;
    dataPointsPossible++;
    const resumeIndustries = (resume.industries_experience || []).map((i) => i.industry);
    if (resumeIndustries.length > 0) dataPointsAvailable++;

    const matchedRequired = findOverlap(jobAI.required_industries, resumeIndustries);
    const matchedPreferred = findOverlap(jobAI.preferred_industries, resumeIndustries);
    if (matchedRequired) {
      score += 25;
      reasons.push(`Your ${matchedRequired} experience matches a required industry`);
    } else if (matchedPreferred) {
      score += 16;
      reasons.push(`Your ${matchedPreferred} experience matches a preferred industry`);
    } else if (Array.isArray(jobAI.required_industries) && jobAI.required_industries.length > 0) {
      concerns.push(`Job requires industry experience (${jobAI.required_industries.join(", ")}) not found on your résumé`);
      hardDisqualifier = true;
      disqualifierCap = Math.min(disqualifierCap, 70);
    } else {
      score += 10; // no specific industry required — neutral credit
    }

    // --- AI product-category match (up to 18 points, spec factor #3) ---
    maxScore += 18;
    dataPointsPossible++;
    const resumeProducts = resume.product_categories || [];
    if (resumeProducts.length > 0) dataPointsAvailable++;
    const matchedProduct = findOverlap(jobAI.product_categories, resumeProducts);
    if (matchedProduct) {
      score += 18;
      reasons.push(`You have direct ${matchedProduct} product experience`);
    } else {
      score += 8; // no match, but not a disqualifier — product experience often transfers
    }

    // --- AI customer/call-point match (up to 18 points, spec factor #4) ---
    maxScore += 18;
    dataPointsPossible++;
    const resumeCustomers = resume.customer_types || [];
    if (resumeCustomers.length > 0) dataPointsAvailable++;
    const matchedCustomer = findOverlap(jobAI.required_customer_types, resumeCustomers);
    if (matchedCustomer) {
      score += 18;
      reasons.push(`You've sold to ${matchedCustomer} before`);
    } else {
      score += 8;
    }

    // --- AI seniority fit (up to 12 points, spec factor #6) ---
    if (resume.seniority_level && jobAI.seniority_level) {
      maxScore += 12;
      dataPointsPossible++;
      dataPointsAvailable++;
      if (resume.seniority_level.toLowerCase() === jobAI.seniority_level.toLowerCase()) {
        score += 12;
        reasons.push(`Seniority level (${jobAI.seniority_level}) matches your background`);
      } else {
        score += 5;
      }
    }

    // --- Sales-motion fit (up to 10 points, spec factor #5) ---
    const resumeMotion = resume.sales_motion || [];
    const jobMotion = jobAI.sales_motion || [];
    if (resumeMotion.length > 0 && jobMotion.length > 0) {
      maxScore += 10;
      dataPointsPossible++;
      dataPointsAvailable++;
      const matchedMotion = findOverlap(jobMotion, resumeMotion);
      if (matchedMotion) {
        score += 10;
        reasons.push(`Your ${matchedMotion} sales experience matches this role's style`);
      } else {
        score += 4;
      }
    }

    // --- Required years of experience (up to 10 points, spec factor #7) ---
    // "Don't automatically reject someone with 4 years when the posting
    // says 5 if the rest of the fit is excellent" — so this is scored
    // gradually, never a hard disqualifier on its own.
    if (resume.total_sales_years != null && jobAI.required_years_experience != null) {
      maxScore += 10;
      dataPointsPossible++;
      dataPointsAvailable++;
      const gap = resume.total_sales_years - jobAI.required_years_experience;
      if (gap >= 0) {
        score += 10;
        reasons.push(`Your ${resume.total_sales_years} years of experience meets the ${jobAI.required_years_experience}-year requirement`);
      } else if (gap >= -2) {
        score += 6;
        concerns.push(`Slightly under the stated ${jobAI.required_years_experience}-year requirement`);
      } else {
        score += 2;
        concerns.push(`Well under the stated ${jobAI.required_years_experience}-year requirement`);
      }
    }

    // --- Specialty experience (up to 8 points, spec factor #9) ---
    const resumeSpecialties = resume.specialties || [];
    const jobSpecialties = jobAI.specialty_requirements || [];
    if (jobSpecialties.length > 0) {
      maxScore += 8;
      dataPointsPossible++;
      if (resumeSpecialties.length > 0) dataPointsAvailable++;
      const matchedSpecialty = findOverlap(jobSpecialties, resumeSpecialties);
      if (matchedSpecialty) {
        score += 8;
        reasons.push(`Your ${matchedSpecialty} specialty experience is a direct match`);
      } else {
        concerns.push(`Job calls for specialty experience (${jobSpecialties.join(", ")}) not shown on your résumé`);
      }
    }

    // --- Performance history bonus (up to 6 points, spec factor #10) ---
    // A positive differentiator, not something that can hurt the score —
    // per the spec, achievements are bonus points beyond the baseline.
    if (Array.isArray(resume.performance_highlights) && resume.performance_highlights.length > 0) {
      maxScore += 6;
      dataPointsPossible++;
      dataPointsAvailable++;
      score += 6;
      reasons.push("Résumé shows documented sales performance achievements");
    }

    // --- Certifications/licensing (up to 5 points, spec factor #15) ---
    const resumeCerts = resume.certifications || [];
    if (resumeCerts.length > 0) {
      maxScore += 5;
      dataPointsPossible++;
      dataPointsAvailable++;
      score += 5;
      reasons.push(`Holds relevant certifications: ${resumeCerts.slice(0, 2).join(", ")}`);
    }

    // --- Semantic similarity via embeddings (up to 15 points, spec
    // factor #46) — genuine embedding-based matching, distinct from the
    // categorized keyword overlap above. Catches conceptual similarity
    // that category matching misses (e.g. "reference laboratory testing"
    // relating to "diagnostic services" even when neither résumé nor job
    // posting uses the other's exact wording).
    //
    // CALIBRATION CAVEAT: the point thresholds below (0.1-0.5 cosine
    // similarity range) are a reasonable starting estimate, not measured
    // against real ROOK résumé/job pairs — this couldn't be tested
    // against the live OpenAI API from the environment this was written
    // in. Expect to retune these thresholds once real embeddings exist
    // to look at; cosine similarity between genuinely different
    // documents rarely approaches 1.0, so treating it as a direct
    // percentage would understate every score.
    const candidateVec = parseVector(profile.candidate_embedding);
    const jobVec = parseVector(job.job_embedding);
    if (candidateVec && jobVec) {
      maxScore += 15;
      dataPointsPossible++;
      dataPointsAvailable++;
      const similarity = cosineSimilarity(candidateVec, jobVec);
      if (similarity != null) {
        const points = Math.max(0, Math.min(15, Math.round(((similarity - 0.1) / 0.4) * 15)));
        score += points;
        if (similarity >= 0.35) {
          reasons.push("Your résumé and this job show strong conceptual overlap");
        } else if (similarity <= 0.15) {
          concerns.push("Your résumé and this job show limited conceptual overlap");
        }
      }
    }

    // --- Clinical requirement hard disqualifier (spec factor #8, #31) ---
    // Only mandatory clinical requirements can trigger this — preferred
    // or boilerplate ones are informational only, per the spec's
    // requirement-strength classification.
    const mandatoryClinical = (jobAI.clinical_requirements || []).filter((r) => r.strength === "mandatory");
    if (mandatoryClinical.length > 0) {
      const resumeClinicalText = (resume.clinical_technical_experience || []).join(" ").toLowerCase();
      const unmet = mandatoryClinical.find(
        (req) => !resumeClinicalText.includes(String(req.requirement).toLowerCase().split(" ")[0])
      );
      if (unmet) {
        concerns.push(`Job requires "${unmet.requirement}" — not clearly shown on your résumé`);
        hardDisqualifier = true;
        disqualifierCap = Math.min(disqualifierCap, 60);
      }
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
