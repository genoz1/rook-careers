// backend/jobEligibility.js
//
// The single, centralized answer to "is this job allowed to appear in
// candidate-facing results at all" — used identically across every
// route that could return a job to a candidate (GET /jobs, /jobs/:id,
// /saved-jobs, /recruiter-jobs, /onboarding/anonymous-preview,
// /onboarding/match-preview, the precompute scoring pool, and
// publicPages.js's public job-detail pages), so the rule can never
// drift into several slightly different copies across those routes.
//
// PURE FUNCTION, NO NETWORK CALLS. isUsEligibleJob() only reads fields
// already stored on the job row (job_lat, job_lng, state, location_raw)
// — it never calls Nominatim or any external service itself. All
// geocoding happens exclusively in backend/geocoding.js at ingestion
// time (and in the standalone backfill/diagnostic scripts). This
// function runs synchronously on every candidate-facing request across
// multiple routes and must stay fast and side-effect-free.
//
// Direct instruction: does NOT modify, import from, or otherwise touch
// backend/matching.js. matching.js's own STATE_ABBR/stateAbbrFromName()
// blindly accepts ANY two-letter string as a "valid" state abbreviation
// (not checked against an actual allowlist) and has no entries at all
// for DC or any US territory — both real, confirmed gaps (see this
// project's assessment) that must NOT be inherited here. This module
// carries its own complete, independent allowlist instead, so fixing
// eligibility can never accidentally change matching/scoring behavior,
// and so this module's correctness never depends on matching.js's.

const { hasUnambiguousForeignCountryEvidence, hasExplicitUsLanguageEvidence } = require("./locationTextRules");

// Complete, independent US state/DC/territory allowlist. Verified
// directly (not assumed) against us-atlas's states-10m.json boundary
// dataset during this project's backfill research: all 50 states, DC
// (FIPS 11), and all 5 territories (American Samoa/60, Guam/66,
// Northern Mariana Islands/69, Puerto Rico/72, U.S. Virgin Islands/78)
// are present in that dataset, so every code accepted here has a real,
// usable boundary for the backfill's point-in-polygon step too.
const US_ELIGIBLE_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY",
  "DC", // District of Columbia
  "PR", "GU", "VI", "AS", "MP", // Puerto Rico, Guam, US Virgin Islands, American Samoa, N. Mariana Islands
]);

// Full name -> code, for resolving what Nominatim/the backfill actually
// stores in the `state` column (full names like "District of Columbia",
// "Puerto Rico" — not abbreviations). Kept complete and independent of
// matching.js's STATE_ABBR by direct instruction (see file header).
const US_STATE_NAME_TO_CODE = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC",
  "puerto rico": "PR", "guam": "GU",
  "u.s. virgin islands": "VI", "united states virgin islands": "VI", "virgin islands": "VI",
  "american samoa": "AS", "northern mariana islands": "MP",
};

/**
 * Resolves a stored `state` value (full name, e.g. "District of
 * Columbia", or a bare 2-letter code) to a code IF AND ONLY IF it's a
 * member of the explicit US_ELIGIBLE_STATE_CODES allowlist above.
 *
 * Deliberately does NOT mirror matching.js's stateAbbrFromName(), which
 * accepts any arbitrary two-letter string as if it were automatically a
 * valid state code. A bare two-letter input here is only accepted when
 * it's actually in the allowlist — direct instruction.
 */
function resolveUsStateCode(stateValue) {
  if (!stateValue) return null;
  const key = String(stateValue).trim().toLowerCase();
  if (!key) return null;
  if (US_STATE_NAME_TO_CODE[key]) return US_STATE_NAME_TO_CODE[key];
  if (/^[a-z]{2}$/i.test(key) && US_ELIGIBLE_STATE_CODES.has(key.toUpperCase())) {
    return key.toUpperCase();
  }
  return null;
}

/**
 * The centralized eligibility gate. Pure, synchronous, no network
 * calls. Implements the decision order established across this
 * project's assessment:
 *
 *   1. Real coordinates + a state/DC/territory that resolves through
 *      the explicit allowlist above -> ELIGIBLE.
 *   2. Otherwise, if the job's own location text unambiguously names a
 *      foreign country, EXCLUDED — this check always wins, even when
 *      explicit-US-sounding text is ALSO present in the same string
 *      (e.g. "United States / Canada" is excluded, not accepted).
 *   3. Otherwise, if the location text carries explicit US-language
 *      evidence ("United States", "USA", "US Territory", etc.),
 *      ELIGIBLE via the fallback — used only when steps 1-2 didn't
 *      already resolve it (i.e. geocoding produced nothing usable and
 *      there's no conflicting foreign evidence).
 *   4. Otherwise, EXCLUDED as unresolved.
 *
 * A job with a resolvable state is decided by step 1 alone — the
 * foreign-country and fallback checks (steps 2-3) are secondary checks
 * for jobs that have no resolvable state, not an override of a
 * genuinely-resolved US location.
 */
function isUsEligibleJob(job) {
  if (!job) return false;

  const hasCoordinates = job.job_lat != null && job.job_lng != null;
  const resolvedState = resolveUsStateCode(job.state);

  if (hasCoordinates && resolvedState) {
    return true;
  }

  if (hasUnambiguousForeignCountryEvidence(job.location_raw)) {
    return false;
  }

  if (hasExplicitUsLanguageEvidence(job.location_raw)) {
    return true;
  }

  return false;
}

module.exports = {
  isUsEligibleJob,
  resolveUsStateCode,
  US_ELIGIBLE_STATE_CODES,
};
