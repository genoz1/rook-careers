// Core logic for the twice-daily social-posting automation's
// foundations (candidate feed, final validation, history/spacing
// rules). Deliberately pure, dependency-free functions wherever
// possible — no Supabase client, no HTTP — so every rule here is
// directly unit-testable without a real database. The Express routes
// in backend/routes/automation.js are thin wrappers that fetch data
// and call into this module.
//
// Buffer publishing itself is explicitly out of scope for this pass —
// nothing here talks to Buffer, Facebook, or LinkedIn.

const crypto = require("crypto");
const { scrubCompanyNameFromText } = require("./routes/jobs");

// =================================================================
// CATEGORY NORMALIZATION
//
// Reported directly, a real gap found during review: jobs.category
// (the raw database column) has NO writer anywhere in the actual
// ingestion pipeline (backend/ingest.js, backend/adapters/*) — it was
// never wired up. The real, populated source of category-like
// information is job.ai_analysis (backend/ai/jobAnalysis.js's output:
// required_industries, preferred_industries, product_categories —
// the exact same fields backend/matching.js already reads for
// real scoring). Building this on the unwritten jobs.category column
// would have made almost every real job silently fail the
// completeness check with no error, ever, in production.
// =================================================================

// The approved PUBLIC social-facing taxonomy, direct instruction.
// Deliberately narrower than jobAnalysis.js's full internal controlled
// vocabulary (which also includes Biotech/Life Sciences, Dental,
// Distribution, Consumables, Reference Laboratory, Point-of-Care
// Diagnostics) — anything that maps to one of those internal-only
// values returns null here, which correctly makes that job NOT
// social_eligible rather than forcing it into an approved bucket it
// doesn't really belong in.
const APPROVED_SOCIAL_CATEGORIES = [
  "Medical Device", "Pharmaceutical", "Diagnostics/Laboratory",
  "Veterinary/Animal Health", "Healthcare SaaS", "Capital Equipment",
];

// Maps the internal controlled vocabulary (jobAnalysis.js /
// resumeAnalysis.js) onto the narrower approved public list.
// Deliberately a real mapping table, not a guess — every internal
// value is either mapped or intentionally excluded (returns null).
const INTERNAL_TO_SOCIAL_CATEGORY = {
  "Medical Device": "Medical Device",
  "Pharmaceutical": "Pharmaceutical",
  "Diagnostics": "Diagnostics/Laboratory",
  "Reference Laboratory": "Diagnostics/Laboratory",
  "Point-of-Care Diagnostics": "Diagnostics/Laboratory",
  "Veterinary/Animal Health": "Veterinary/Animal Health",
  "Healthcare SaaS": "Healthcare SaaS",
  "Capital Equipment": "Capital Equipment",
  // Deliberately excluded (no clean public category to assign):
  // "Biotech/Life Sciences", "Dental", "Distribution", "Consumables"
};

/**
 * Derives the single approved public category for a job from its real
 * AI analysis data, or null if none of the job's stated
 * industries/product categories map to an approved public label. A
 * job with ai_analysis pending/missing entirely also returns null —
 * correctly excluding it from social eligibility rather than guessing.
 */
function normalizeCategoryForSocial(job) {
  const ai = job.ai_analysis;
  if (!ai || typeof ai !== "object") return null;

  const candidates = [
    ...(Array.isArray(ai.required_industries) ? ai.required_industries : []),
    ...(Array.isArray(ai.preferred_industries) ? ai.preferred_industries : []),
    ...(Array.isArray(ai.product_categories) ? ai.product_categories : []),
  ];

  for (const value of candidates) {
    const mapped = INTERNAL_TO_SOCIAL_CATEGORY[value];
    if (mapped) return mapped;
  }
  return null;
}

// =================================================================
// social_eligible — how it's populated and maintained (documented,
// conservative rules; see the ingest.js call site for how this gets
// re-evaluated on every re-ingestion pass, not just set once).
// =================================================================

/**
 * The single, documented rule set for whether a job may EVER be
 * marked social_eligible. Called from backend/ingest.js on every
 * upsert (every re-ingestion pass, not just job creation), so a job
 * that becomes incomplete or loses its category mapping later is
 * correctly re-evaluated to false, not left stuck at whatever it was
 * set to once. Direct instruction: this must not make every job
 * eligible by default — every one of these conditions is a real,
 * exclusionary check, not a formality.
 */
function evaluateSocialEligibilityForIngestion(job) {
  // Only ATS-verified, direct-from-employer postings — recruiter-
  // submitted and third-party-aggregated listings are excluded from
  // social promotion entirely (lower confidence in long-term accuracy
  // and consistent re-verification for recruiter_posted; not directly
  // sourced from the employer at all for agency_aggregated).
  if (job.source_type === "recruiter_posted" || job.source_type === "agency_aggregated") return false;

  if (!job.title_original || !String(job.title_original).trim()) return false;
  if (!job.location_raw && !job.territory) return false;

  // Must map to one of the approved public categories — see above.
  if (!normalizeCategoryForSocial(job)) return false;

  return true;
}

// Direct instruction: a bug or unexpected data shape in social-
// eligibility evaluation must NEVER cause a normal job import/update
// to fail — this is genuinely additive, best-effort classification
// layered on top of ingestion that already worked correctly before
// social automation existed, not a required step ingestion now
// depends on. Reported directly as a real, current gap: the call site
// in ingest.js has no surrounding try/catch, so an uncaught error here
// would currently abort that job's entire upsert (and, depending on
// where in the loop it happened, every remaining job for that
// employer this run) — not just fail to classify it for social. This
// wrapper is what every real call site should use instead of the raw
// function above: same rules, but any failure is caught here, logged,
// and safely defaults to "not eligible" rather than ever propagating
// out to touch the surrounding upsert logic at all.
function safeEvaluateSocialEligibilityForIngestion(job) {
  try {
    return evaluateSocialEligibilityForIngestion(job);
  } catch (err) {
    console.error(`[social-automation] eligibility evaluation failed for job "${job?.title_original || "(unknown)"}" — defaulting to not eligible, job import continues normally: ${err.message}`);
    return false;
  }
}

// =================================================================
// Content versioning — detects "the listing changed after selection"
// without a stored version column. A deterministic hash of exactly the
// fields a social post actually shows; any change to any of them
// changes the version, so a stale content_version passed into the
// validate endpoint is a reliable signal the listing has moved on.
// =================================================================
const CONTENT_VERSION_FIELDS = [
  "title_original", "location_raw", "territory",
  "compensation_text", "salary_min", "salary_max",
  "employment_type", "remote_status", "status", "moderation_status",
  "social_eligible", "experience_min_years",
];

function computeContentVersion(job) {
  const relevant = [
    ...CONTENT_VERSION_FIELDS.map((f) => `${f}=${job[f] ?? ""}`),
    `category=${normalizeCategoryForSocial(job) ?? ""}`,
  ].join("|");
  return crypto.createHash("sha256").update(relevant).digest("hex").slice(0, 16);
}

// =================================================================
// Employer spacing key — a stable, non-reversible identifier for "this
// is the same employer" without ever exposing which employer it is.
// =================================================================
function computeEmployerSpacingKey(employerId, secret) {
  if (!employerId) return null;
  if (!secret) throw new Error("SOCIAL_SPACING_HMAC_SECRET is not configured — refusing to compute an employer spacing key without it");
  return crypto.createHmac("sha256", secret).update(String(employerId)).digest("hex");
}

// =================================================================
// Job fingerprint — a STABLE identifier that survives the underlying
// jobs row being permanently deleted (see backend/archiveOldJobs.js:
// closed jobs are hard-deleted after 90 days). job_id alone is NOT
// sufficient for permanent duplicate prevention, because a deleted-
// then-reimported posting (the employer relists the same role later,
// or it briefly disappears and reappears in a source feed) gets a
// BRAND NEW jobs.id on re-ingestion — employer_id+source_job_id is the
// one true stable identity for "this is fundamentally the same
// listing," and it's exactly what ingest.js's own upsert already keys
// on (onConflict: "employer_id,source_job_id"). Non-reversible, same
// reasoning as the employer spacing key.
// =================================================================
function computeJobFingerprint(employerId, sourceJobId, secret) {
  if (!employerId || !sourceJobId) return null;
  if (!secret) throw new Error("SOCIAL_SPACING_HMAC_SECRET is not configured — refusing to compute a job fingerprint without it");
  return crypto.createHmac("sha256", secret).update(`${employerId}|${sourceJobId}`).digest("hex");
}

// =================================================================
// Branded/product-term protection.
//
// Direct instruction: an empty SOCIAL_BRANDED_TERMS is not sufficient.
// Primary protection remains the allowlist-only construction of
// social_safe_hook (below) — it's never built from free text, so there
// is nothing for a branded term to hide inside in the first place.
// This is the secondary, defense-in-depth net, and it now has a REAL
// starting source: every known company_name already on file in the
// employers table (~237 as of this writing), which is exactly the set
// of names that could otherwise slip through if a title or category
// value ever contained one. Combined with any additional terms from
// SOCIAL_BRANDED_TERMS (product/program names, which don't come from
// any existing table and must be maintained manually going forward —
// there is no authoritative source for those anywhere in the app).
// =================================================================
function buildBrandedTermList(employerCompanyNames = [], additionalTerms = []) {
  const fromEmployers = (employerCompanyNames || []).filter(Boolean).map((name) => String(name).trim());
  const fromEnv = (additionalTerms || []).filter(Boolean).map((t) => String(t).trim());
  return [...new Set([...fromEmployers, ...fromEnv])];
}

// =================================================================
// Social-safe hook — built ONLY from a fixed allowlist of already-
// structured fields (never free text like description_text or the raw
// ai_analysis blob), so there is no branded terminology, slogan, or
// proprietary language to accidentally include in the first place —
// the safety comes from what this function is given, not from
// scrubbing something after the fact. No LLM involved in this pass.
// =================================================================
// Very narrow, low-risk transform used only for hook phrasing below —
// strips a trailing "s" for simple plurals ("Hospitals" -> "Hospital")
// so a stored customer-type value reads naturally in a sentence. Not
// a general-purpose linguistic tool; deliberately conservative (only
// fires on a plain trailing "s" on a long-enough word) so it never
// mangles a word it doesn't recognize.
function singularizeForHook(word) {
  const trimmed = String(word || "").trim();
  if (/s$/i.test(trimmed) && trimmed.length > 3) return trimmed.slice(0, -1);
  return trimmed;
}

// Direct instruction: a factual hook may also be derived
// deterministically from stored ai_analysis fields (sales_motion,
// required_customer_types, specialty_requirements) — the same fields
// backend/matching.js already treats as real, extracted-not-invented
// data (see backend/ai/jobAnalysis.js's own "Extract ONLY what the
// posting actually states" instruction). This only ever recombines
// values already present in that stored data into a short sentence
// template — it never adds a claim, qualification, benefit, or
// employer detail that wasn't already there.
function generateHookFromAiAnalysis(job) {
  const ai = job.ai_analysis;
  if (!ai || typeof ai !== "object") return null;

  const customerType = Array.isArray(ai.required_customer_types) && ai.required_customer_types.length > 0
    ? String(ai.required_customer_types[0]).trim() : null;
  const specialty = Array.isArray(ai.specialty_requirements) && ai.specialty_requirements.length > 0
    ? String(ai.specialty_requirements[0]).trim() : null;
  const motion = Array.isArray(ai.sales_motion) && ai.sales_motion.length > 0
    ? String(ai.sales_motion[0]).trim() : null;

  if (customerType && specialty) {
    return `Support ${singularizeForHook(customerType).toLowerCase()} relationships and ${specialty.toLowerCase()}`;
  }
  if (customerType) {
    return `Support ${singularizeForHook(customerType).toLowerCase()} relationships`;
  }
  if (specialty) {
    return `Focus on ${specialty.toLowerCase()}`;
  }
  if (motion) {
    return `${motion} sales role`;
  }
  return null;
}

function generateSocialSafeHook(job) {
  const parts = [];

  if (job.compensation_text && String(job.compensation_text).trim()) {
    parts.push(String(job.compensation_text).trim());
  } else if (job.salary_min != null && job.salary_max != null) {
    parts.push(`$${Number(job.salary_min).toLocaleString()}–$${Number(job.salary_max).toLocaleString()}`);
  }

  if (job.remote_status === "remote") parts.push("Remote");
  else if (job.remote_status === "hybrid") parts.push("Hybrid");

  if (job.employment_type && /full.?time/i.test(job.employment_type)) parts.push("Full-Time");

  if (job.experience_min_years != null) {
    parts.push(`${job.experience_min_years}+ yrs experience`);
  }

  if (parts.length > 0) return parts.slice(0, 3).join(" · "); // short — this is a hook, not a summary

  // Nothing in the primary allowlist (compensation/remote/employment/
  // experience) — try the stored ai_analysis fields before giving up.
  // Direct instruction: if neither path yields a safe hook, the job
  // is excluded rather than posted with an invented one.
  return generateHookFromAiAnalysis(job);
}

function containsEmployerIdentity(text, companyName) {
  if (!text || !companyName) return false;
  const scrubbed = scrubCompanyNameFromText(text, companyName);
  return scrubbed !== text;
}

function containsBrandedTerm(text, brandedTerms) {
  if (!text || !brandedTerms || brandedTerms.length === 0) return false;
  const lower = text.toLowerCase();
  return brandedTerms.some((term) => term && lower.includes(String(term).toLowerCase()));
}

// =================================================================
// Completeness — the minimum a social post needs to be a genuine,
// factual representation of the role, not a placeholder. Uses the
// REAL category source, not the unwritten jobs.category column.
// =================================================================
function isSociallyComplete(job) {
  return Boolean(
    job.title_original && String(job.title_original).trim() &&
    (job.location_raw || job.territory) &&
    normalizeCategoryForSocial(job)
  );
}

// =================================================================
// Location normalization — direct instruction: "USA OH - Cleveland"
// style ATS exports (country + state code + dash + city) must render
// as "Cleveland, OH". Only reformats a recognized pattern; anything
// that doesn't match is returned unchanged rather than guessed at.
// =================================================================
function normalizeLocationForSocial(locationRaw) {
  if (!locationRaw) return locationRaw;
  const text = String(locationRaw).trim();
  const match = text.match(/^(?:USA|US)\s+([A-Za-z]{2})\s*-\s*(.+)$/);
  if (match) {
    const state = match[1].toUpperCase();
    const city = match[2].trim();
    if (city) return `${city}, ${state}`;
  }
  return text;
}

// Direct instruction: avoid duplicating the location in both the
// title and location field when the title already ends with the same
// city — but never materially rewrite the underlying role name. This
// only ever decides whether to ALSO surface a separate location fact;
// it never touches job.title_original itself, which is passed through
// completely unchanged everywhere.
function dedupeLocationAgainstTitle(title, locationDisplay) {
  if (!title || !locationDisplay) return locationDisplay;
  const cityPart = String(locationDisplay).split(",")[0].trim().toLowerCase();
  const titleLower = String(title).trim().toLowerCase();
  if (cityPart && titleLower.endsWith(cityPart)) {
    return null; // redundant — the title already conveys this; the graphic's existing reflow rules cleanly omit a null field
  }
  return locationDisplay;
}

// =================================================================
// Fact-count and richness — direct instruction: require enough
// verified data to populate at least four useful middle-panel facts,
// and strongly prefer candidates with compensation, employment type,
// work arrangement, and a factual hook, all specifically. These are
// the same fields backend/socialGraphic.js's fact grid draws from
// (see buildFactList there) — this just counts them here, at
// selection time, without importing the graphic module itself.
// =================================================================
function countAvailableFacts(job) {
  let count = 0;
  if (job.location_raw || job.territory) count++;
  if (normalizeCategoryForSocial(job)) count++;
  if (job.compensation_text || (job.salary_min && job.salary_max)) count++;
  if (job.employment_type) count++;
  if (job.remote_status) count++;
  return count;
}

// Counts specifically the four fields direct instruction calls out —
// a narrower, stronger signal than the general fact count above, used
// to drive the "strongly prefer" ranking rather than the pass/fail gate.
function computeRichnessScore(job) {
  let score = 0;
  if (job.compensation_text || (job.salary_min && job.salary_max)) score++;
  if (job.employment_type) score++;
  if (job.remote_status) score++;
  if (generateSocialSafeHook(job)) score++;
  return score;
}


// =================================================================
// Active-job predicate — ONE definition, used everywhere (candidate
// feed's pre-filter, final validation, and public_url_valid's
// baseline). This is not a guess: it's proven identical to the real
// public route's actual behavior by the database's own RLS policy —
// see backend/db/schema.sql's "public can read active jobs" policy,
// which enforces status='active' AND moderation_status='approved' for
// ANY anon-key query, including the one publicPages.js's /jobs/:id
// route runs, regardless of what that route's own application code
// explicitly filters for. This is the actual, mechanically-enforced
// definition of "publicly visible," not an assumption about it.
// =================================================================
function isActiveJob(job) {
  return job.status === "active" && job.moderation_status === "approved";
}

// =================================================================
// Eligibility — the shared set of checks both the candidate feed
// (implicitly, by filtering) and the final-validation endpoint
// (explicitly, returning reason_codes) rely on.
// =================================================================
function evaluateEligibility(job, { freshnessWindowDays, now = new Date(), expectedContentVersion, brandedTerms = [] } = {}) {
  const reasonCodes = [];

  const active = isActiveJob(job);
  if (!active) reasonCodes.push("inactive");

  // expires_at has NO real writer anywhere in the current ingestion
  // system (no ATS source this app integrates with exposes an
  // explicit closing date) — documented, not silently assumed. Kept
  // as a nullable, forward-compatible field; genuine expiration
  // detection for this system is status+last_seen_at, both of which
  // ARE actively maintained by every ingestion pass (see
  // backend/ingest.js: status flips to 'closed' the moment a
  // previously-seen job stops appearing in a fresh crawl of that
  // employer's feed). A real expires_at, if one is ever populated by
  // a future source, is still honored here — this just never assumes
  // one exists.
  const notExpired = !job.expires_at || new Date(job.expires_at) > now;
  if (!notExpired) reasonCodes.push("expired");

  if (!job.social_eligible) reasonCodes.push("not_social_eligible");

  if (!isSociallyComplete(job)) reasonCodes.push("incomplete_fields");

  // Direct instruction: compensation, employment type, and work
  // arrangement are weighted ranking bonuses (see computeRichnessScore
  // and scoreAndSortCandidates), never hard requirements — a
  // genuinely eligible job must not be rejected just for lacking one
  // or more of these. The only hard content-completeness bar remains
  // isSociallyComplete's title + normalized location + approved
  // category above.

  // A factual hook, derived only from stored listing data, IS still
  // required — either from the primary allowlist (compensation/
  // remote/employment/experience) or, when that yields nothing, from
  // stored ai_analysis fields (sales_motion, required_customer_types,
  // specialty_requirements — see generateHookFromAiAnalysis). If
  // neither path produces a safe hook, the job is excluded rather
  // than posted with an empty hook section.
  const hook = generateSocialSafeHook(job);
  if (!hook) reasonCodes.push("no_factual_hook");

  // last_seen_at genuinely proves re-verification, not just "row
  // exists": backend/ingest.js sets it to the current timestamp only
  // inside the per-job loop that runs over jobs just freshly fetched
  // from that employer's live ATS feed THIS run — a job not present in
  // a fresh fetch never gets touched here at all (it gets marked
  // status='closed' instead, in the separate step right after). A
  // failed fetch for an employer (network error, ATS down) means the
  // loop body never executes for that employer's jobs this run, so
  // last_seen_at is never falsely bumped by a run that didn't actually
  // re-check anything.
  const lastVerifiedAt = job.last_seen_at ? new Date(job.last_seen_at) : null;
  const freshnessMs = (freshnessWindowDays ?? 3) * 24 * 60 * 60 * 1000;
  const freshEnough = lastVerifiedAt && (now.getTime() - lastVerifiedAt.getTime()) <= freshnessMs;
  if (!freshEnough) reasonCodes.push("stale_verification");

  const publicUrlValid = active; // see isActiveJob's doc comment — RLS-proven, not assumed
  if (!publicUrlValid) reasonCodes.push("invalid_public_url");

  const currentContentVersion = computeContentVersion(job);
  const contentUnchanged = !expectedContentVersion || expectedContentVersion === currentContentVersion;
  if (!contentUnchanged) reasonCodes.push("content_changed");

  const redactionOk =
    !containsEmployerIdentity(hook, job.company_name) &&
    !containsEmployerIdentity(job.title_original, job.company_name) &&
    !containsBrandedTerm(hook, brandedTerms) &&
    !containsBrandedTerm(job.title_original, brandedTerms);
  if (!redactionOk) reasonCodes.push("redaction_failed");

  return {
    eligible: reasonCodes.length === 0,
    active,
    public_url_valid: publicUrlValid,
    last_verified_at: job.last_seen_at || null,
    expires_at: job.expires_at || null,
    content_version: currentContentVersion,
    reason_codes: reasonCodes,
  };
}

// =================================================================
// Candidate scoring — direct instruction: do not simply sort by
// creation date. Tuple-style comparator (earlier criteria dominate
// later ones), not a blended numeric score.
// =================================================================
function scoreAndSortCandidates(jobs, {
  previouslyFeaturedJobIds = new Set(),
  excludedJobIds = new Set(), // e.g. the AM slot's job, excluded from the PM run
  recentEmployerSpacingKeys = new Set(),
  recentCategories = [], // categories featured recently — direct instruction: strongly prefer variation
  preferredCategories = [],
  preferredTerritories = [],
  spacingSecret,
} = {}) {
  const scored = jobs
    .filter((job) => !excludedJobIds.has(job.id))
    .map((job) => {
      const spacingKey = computeEmployerSpacingKey(job.employer_id, spacingSecret);
      const category = normalizeCategoryForSocial(job);
      return {
        job,
        spacingKey,
        category,
        richness: computeRichnessScore(job),
        fieldCount: countAvailableFacts(job),
        neverFeatured: !previouslyFeaturedJobIds.has(job.id) ? 1 : 0,
        complete: isSociallyComplete(job) ? 1 : 0,
        preferredCategory: preferredCategories.includes(category) ? 1 : 0,
        preferredTerritory: preferredTerritories.includes(job.territory) ? 1 : 0,
        categoryVaried: (category && !recentCategories.includes(category)) ? 1 : 0,
        employerSpaced: (spacingKey && !recentEmployerSpacingKeys.has(spacingKey)) ? 1 : 0,
        lastSeenAtMs: job.last_seen_at ? new Date(job.last_seen_at).getTime() : 0,
      };
    })
    .sort((a, b) => {
      // 1. Direct instruction: strongly prefer richer candidates
      // (compensation, employment type, work arrangement, a factual
      // hook) — this now dominates the ranking, ahead of freshness.
      if (b.richness !== a.richness) return b.richness - a.richness;
      // 2. Direct instruction: among otherwise-similar candidates,
      // prefer the one with the greatest number of verified display
      // fields overall (location/category are always present once
      // eligible, so this mainly differentiates on the same optional
      // fields richness already weighs, plus acts as a finer-grained
      // tiebreaker within a richness tier).
      if (b.fieldCount !== a.fieldCount) return b.fieldCount - a.fieldCount;
      // 3. never previously featured
      if (b.neverFeatured !== a.neverFeatured) return b.neverFeatured - a.neverFeatured;
      // 4. listing completeness
      if (b.complete !== a.complete) return b.complete - a.complete;
      // 5. preferred category and territory quality
      const aPref = a.preferredCategory + a.preferredTerritory;
      const bPref = b.preferredCategory + b.preferredTerritory;
      if (bPref !== aPref) return bPref - aPref;
      // 6. category variation
      if (b.categoryVaried !== a.categoryVaried) return b.categoryVaried - a.categoryVaried;
      // 7. employer spacing
      if (b.employerSpaced !== a.employerSpaced) return b.employerSpaced - a.employerSpaced;
      // 8. freshness — direct instruction: freshness remains important
      // but must not outweigh content completeness and presentation
      // quality, so it's now the LAST tiebreaker, not the first.
      if (b.lastSeenAtMs !== a.lastSeenAtMs) return b.lastSeenAtMs - a.lastSeenAtMs;
      return 0;
    });

  return scored.map((s) => s.job);
}

function buildCandidateResponse(job, spacingSecret) {
  const normalizedLocation = normalizeLocationForSocial(job.location_raw);
  const dedupedLocation = dedupeLocationAgainstTitle(job.title_original, normalizedLocation);
  return {
    job_id: job.id,
    public_url: `https://rookcareers.com/jobs/${job.id}`,
    title: job.title_original, // never rewritten, regardless of any location normalization/dedup applied below
    location_display: dedupedLocation,
    territory_display: job.territory || null,
    category: normalizeCategoryForSocial(job),
    compensation_display: (job.compensation_text || (job.salary_min && job.salary_max))
      ? (job.compensation_text || `$${Number(job.salary_min).toLocaleString()}–$${Number(job.salary_max).toLocaleString()}`)
      : null,
    employment_type: job.employment_type || null,
    work_arrangement: job.remote_status || null,
    social_safe_hook: generateSocialSafeHook(job),
    last_verified_at: job.last_seen_at || null,
    expires_at: job.expires_at || null,
    employer_spacing_key: computeEmployerSpacingKey(job.employer_id, spacingSecret),
    content_version: computeContentVersion(job),
  };
}

// =================================================================
// Scheduling helpers — DST-safe conversion from an America/New_York
// wall-clock time to the correct UTC instant, using Node's built-in
// Intl/ICU timezone data. Verified directly against both 2026 DST
// transition dates (spring-forward March 8, fall-back November 1).
// =================================================================
function nyWallClockToUtc(dateStr, hour, minute) {
  const naiveUtcGuess = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const nyFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = nyFormatter.formatToParts(naiveUtcGuess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, parts.hour === "24" ? 0 : +parts.hour, +parts.minute, +parts.second);
  const offsetMs = naiveUtcGuess.getTime() - asIfUtc;
  return new Date(naiveUtcGuess.getTime() + offsetMs);
}

function computeRunKey(dateStr, slot) {
  return `${dateStr}-${slot.toUpperCase()}`;
}

function computeScheduledForUtc(dateStr, slot) {
  return slot === "pm" ? nyWallClockToUtc(dateStr, 17, 0) : nyWallClockToUtc(dateStr, 9, 0);
}

function buildHistoryRow({ runKey, slot, jobId, jobFingerprint, contentVersion, employerSpacingKey, category, scheduledFor, facebook, linkedin, creativeUrl, captionVersion, selectedAt, validatedAt, failureReason }) {
  return {
    run_key: runKey,
    slot,
    job_id: jobId,
    job_fingerprint: jobFingerprint,
    job_content_version: contentVersion,
    employer_spacing_key: employerSpacingKey,
    category: category || null,
    scheduled_for: scheduledFor,
    facebook_channel_id: facebook?.channelId || null,
    facebook_buffer_post_id: facebook?.bufferPostId || null,
    facebook_status: facebook?.status || null,
    linkedin_channel_id: linkedin?.channelId || null,
    linkedin_buffer_post_id: linkedin?.bufferPostId || null,
    linkedin_status: linkedin?.status || null,
    creative_url: creativeUrl || null,
    caption_version: captionVersion || null,
    selected_at: selectedAt || null,
    validated_at: validatedAt || null,
    failure_reason: failureReason || null,
  };
}

module.exports = {
  APPROVED_SOCIAL_CATEGORIES,
  normalizeCategoryForSocial,
  normalizeLocationForSocial,
  dedupeLocationAgainstTitle,
  countAvailableFacts,
  computeRichnessScore,
  generateHookFromAiAnalysis,
  evaluateSocialEligibilityForIngestion,
  safeEvaluateSocialEligibilityForIngestion,
  computeContentVersion,
  computeEmployerSpacingKey,
  computeJobFingerprint,
  buildBrandedTermList,
  generateSocialSafeHook,
  containsEmployerIdentity,
  containsBrandedTerm,
  isSociallyComplete,
  isActiveJob,
  evaluateEligibility,
  scoreAndSortCandidates,
  buildCandidateResponse,
  nyWallClockToUtc,
  computeRunKey,
  computeScheduledForUtc,
  buildHistoryRow,
};
