// Matching engine — Phase 1 slice.
//
// This is the first real piece of the matching engine described in the
// architecture spec (section 9). It is deliberately narrow: it scores on
// the two factors ROOK can reliably compare right now — location and
// compensation — using data that's already being collected (candidate
// profile fields from onboarding, and each job's location_raw /
// compensation_text). Everything else in the spec's weighted model
// (industry experience, required experience, skills, travel, semantic
// similarity) needs either résumé parsing or embeddings, neither of which
// exist yet — this is NOT the full matching engine, just its first
// working slice, and it should be extended rather than replaced as those
// other pieces get built.
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
  if (/^[a-z]{2}$/i.test(key)) return key.toUpperCase(); // already an abbreviation
  return null;
}

function locationMentionsState(locationRaw, stateAbbr) {
  if (!locationRaw || !stateAbbr) return false;
  // Matches "FL" as a whole word (comma/space/paren-delimited), e.g.
  // "Orlando, FL" or "Columbus, OH (US)" — not a substring inside another word.
  const pattern = new RegExp(`\\b${stateAbbr}\\b`, "i");
  return pattern.test(locationRaw);
}

// Pulls the highest plausible salary figure out of free-text compensation
// info, whichever field has it. Handles "$95,000", "$95K", "95000", etc.
// Returns null if nothing parseable is found — deliberately conservative,
// since guessing wrong here is worse than saying "unknown."
function extractSalaryFigure(job) {
  if (job.salary_max) return Number(job.salary_max);
  if (job.salary_min) return Number(job.salary_min);
  const text = job.compensation_text || "";
  const matches = [...text.matchAll(/\$?([\d,]+(?:\.\d+)?)\s*(k|K)?/g)];
  let best = null;
  for (const m of matches) {
    let val = parseFloat(m[1].replace(/,/g, ""));
    if (!val) continue;
    if (m[2]) val *= 1000; // "95K" -> 95000
    if (val < 1000) continue; // ignore stray small numbers (e.g. "50%" travel)
    if (best === null || val > best) best = val;
  }
  return best;
}

/**
 * Score one job against one candidate profile.
 *
 * @param {object} job - a row from the jobs table
 * @param {object} profile - a row from the candidate_profiles table
 * @returns {{ overall_score: number, reasons: string[], concerns: string[] }}
 */
function scoreJob(job, profile) {
  const reasons = [];
  const concerns = [];
  let score = 0;
  let maxScore = 0;

  // --- Location (up to 50 points) ---
  maxScore += 50;
  const remoteFriendly = /remote/i.test(job.location_raw || "") || job.remote_status === "remote";
  const candidateStateAbbr = stateAbbrFromName(profile.home_state);

  if (candidateStateAbbr && locationMentionsState(job.location_raw, candidateStateAbbr)) {
    score += 50;
    reasons.push("Location matches your home state");
  } else if (remoteFriendly) {
    score += 40;
    reasons.push("Remote-friendly role");
  } else if (profile.willing_to_relocate) {
    score += 20;
    reasons.push("You've indicated openness to relocation");
  } else if (candidateStateAbbr && job.location_raw) {
    concerns.push(`Location (${job.location_raw}) may be outside your home state`);
  }

  // --- Compensation (up to 50 points) ---
  maxScore += 50;
  const jobSalary = extractSalaryFigure(job);
  if (profile.minimum_base_salary && jobSalary) {
    if (jobSalary >= profile.minimum_base_salary) {
      score += 50;
      reasons.push("Compensation meets your stated minimum");
    } else {
      score += 10;
      concerns.push("Compensation may be below your stated minimum");
    }
  } else if (jobSalary) {
    // We know the job's pay but not the candidate's floor — neutral credit.
    score += 30;
  } else {
    // Neither side has a number — genuinely unknown, not a strike either way.
    score += 25;
  }

  const overall_score = maxScore > 0 ? Math.round((score / maxScore) * 100) : null;

  return { overall_score, reasons, concerns };
}

module.exports = { scoreJob, stateAbbrFromName, extractSalaryFigure };
