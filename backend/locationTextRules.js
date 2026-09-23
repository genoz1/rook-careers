// Shared, pure, network-free location text classification helpers.
//
// Used by TWO different runtime contexts that both need the identical
// answer to "does this text unambiguously name a foreign country?":
//   1. backend/geocoding.js — ingestion-time pre-check, decides whether
//      to even attempt a Nominatim call for a job's location text.
//   2. backend/jobEligibility.js — request-time fallback-override check,
//      decides whether the explicit-US-language fallback is allowed to
//      apply when a job has no coordinates/state on file.
// Kept as one shared module specifically so these two call sites can
// never drift apart the way STATE_ABBR (in matching.js) and this
// project's own isolated allowlist could have, if each had grown its
// own copy of "what counts as foreign."
//
// Zero external dependencies beyond the (already-approved,
// already-installed) i18n-iso-countries package — no network calls,
// no database access, safe to require from a pure function.

const countries = require("i18n-iso-countries");
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));

// US territories are their own ISO entries but are legitimately
// eligible U.S. locations, not foreign — excluded from the foreign-name
// list. (jobEligibility.js's own separate state/territory allowlist is
// what actually accepts these; this module only needs to not reject
// them as foreign.)
const US_TERRITORY_NAMES = new Set([
  "american samoa", "guam", "northern mariana islands", "puerto rico",
  "u.s. virgin islands", "united states virgin islands",
  "virgin islands, u.s.", "virgin islands (u.s.)",
]);

// Georgia collides with a real US state name — direct instruction:
// bare "Georgia" now DEFAULTS to the US state. It's only treated as the
// foreign country when the surrounding text has affirmative foreign
// context. Handled as a special case below, not as a plain list entry.
const GEORGIA_FOREIGN_CONTEXT_SIGNALS = [/\btbilisi\b/i, /\bcountry of georgia\b/i, /\beurope\b/i, /\bcaucasus\b/i];

function buildForeignCountryNames() {
  const official = Object.values(countries.getNames("en", { select: "official" }));
  const common = Object.values(countries.getNames("en", { select: "alias" }));
  return [...new Set([...official, ...common])]
    .filter((n) => !/united states/i.test(n))
    .filter((n) => !US_TERRITORY_NAMES.has(n.toLowerCase()))
    .filter((n) => n.toLowerCase() !== "georgia"); // handled specially, not as a plain entry
}

const FOREIGN_COUNTRY_NAMES = buildForeignCountryNames();

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLocationText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

// Matches a country name as a whole word/phrase anywhere in the text —
// safe for this specific use case (short, structured job-location
// strings like "City, State" or "United States / Canada"), unlike a
// bare substring match against long free-text (which could false-
// positive on an unrelated word containing the same letters). A plain
// prefix/suffix-only pattern was tried first but missed real
// conflicting-location text using a "/" separator (e.g. "United States
// / Canada") — direct instruction requires that case to be caught, so
// this uses \b word boundaries instead of specific separator characters.
function textNamesCountry(text, countryName) {
  const c = escapeRegex(countryName);
  const pattern = new RegExp(`\\b${c}\\b`, "i");
  return pattern.test(text);
}

/**
 * True if `locationRaw` unambiguously names a foreign country. This is
 * the single check shared by both the ingestion-time pre-check (reject
 * before ever calling Nominatim) and the request-time fallback-override
 * check (foreign evidence beats the explicit-US-language fallback).
 *
 * Georgia is handled specially per direct instruction: bare "Georgia"
 * defaults to the US state and is NOT flagged as foreign unless the
 * text also contains an affirmative foreign-context signal (Tbilisi,
 * "Country of Georgia", Europe, Caucasus).
 */
function hasUnambiguousForeignCountryEvidence(locationRaw) {
  const text = normalizeLocationText(locationRaw);
  if (!text) return false;

  if (/\bgeorgia\b/i.test(text)) {
    const hasForeignContext = GEORGIA_FOREIGN_CONTEXT_SIGNALS.some((re) => re.test(text));
    if (hasForeignContext) return true;
    // No affirmative foreign context — bare "Georgia" (with or without
    // other US signals) is treated as the US state, per direct
    // instruction. Fall through to check the REST of the string against
    // every other country name (a string could still separately name a
    // different foreign country alongside an unrelated "Georgia").
  }

  for (const name of FOREIGN_COUNTRY_NAMES) {
    // Remove only the two unambiguous U.S. phrases for the Jersey check.
    // A separate Jersey or another foreign country must still win.
    const countryText = name.toLowerCase() === 'jersey'
      ? text.replace(/\bnew\s+jersey\b|\bjersey\s+city\b/gi, ' ')
      : text;
    if (textNamesCountry(countryText, name)) return true;
  }
  return false;
}

// Direct instruction: the narrowest defensible fix here, not a general
// world-cities database (no reliable, complete "all city names" dataset
// exists the way i18n-iso-countries exists for countries, and building
// one would be a much larger, different project than what was asked).
// Confirmed by direct investigation, not inferred from a coordinate:
// two real Sanofi postings use bare "Barcelona" — no state, country, or
// any other qualifier at all — as their ENTIRE location_raw for jobs
// actually based in Barcelona, SPAIN (one description explicitly states
// "Location: Barcelona, Spain"; the other is written entirely in
// Spanish describing Spanish healthcare regions). That bare string
// coincidentally matches a real place, Barcelona, in Chautauqua County,
// NY. A legitimate US posting for a small town essentially never omits
// ALL state/country context the way this employer's board does for its
// home-market (Spain) postings — kept as an explicit, minimal, named
// list, scoped to exactly this confirmed case. Extend only when another
// concrete case is investigated and confirmed the same way — never
// preemptively, and never by broadening this into a general foreign-
// city check.
const KNOWN_AMBIGUOUS_BARE_CITY_NAMES = new Set(["barcelona"]);

function isBareAmbiguousForeignCityName(locationRaw) {
  const text = normalizeLocationText(locationRaw).toLowerCase();
  return KNOWN_AMBIGUOUS_BARE_CITY_NAMES.has(text);
}

// Bare generic work-arrangement terms with no location content at all.
// Proven necessary, not theoretical: a live Nominatim query for the
// single word "Remote" returns a real match — an actual hamlet in Coos
// County, Oregon — under the exact same countrycodes=us-restricted
// query already used in production. Rejecting these BEFORE geocoding
// prevents that exact false-positive class entirely, rather than
// relying on the result-type check to catch it (a hamlet is a
// legitimate "place"-category result, so the result-type check alone
// would not catch this one).
const BARE_GENERIC_REMOTE_TERM = /^(remote|wfh|virtual|telecommute)(\s*\(wfh\))?$/i;

function isBareGenericRemoteTerm(locationRaw) {
  const text = normalizeLocationText(locationRaw);
  return BARE_GENERIC_REMOTE_TERM.test(text);
}

// Explicit US-language fallback — used ONLY when geocoding produced no
// coordinates at all (confirmed necessary: every one of these real
// patterns returns zero Nominatim results) AND no foreign evidence is
// present (foreign evidence always wins — see hasUnambiguousForeignCountryEvidence).
function hasExplicitUsLanguageEvidence(locationRaw) {
  const text = normalizeLocationText(locationRaw);
  if (!text) return false;
  return (
    /(united states|\busa\b|\bu\.s\.a\.\b)/i.test(text) ||
    /\bus\b.*(field|territory|remote|home office)/i.test(text) ||
    /(field|territory|remote|home office).*\bus\b/i.test(text) ||
    /nationwide.*(us|united states)/i.test(text)
  );
}

module.exports = {
  normalizeCountryCode(value) {
    const raw = String(value || '').trim();
    if (/^(US|USA|PR|GU|VI|AS|MP)$/i.test(raw)) return raw.toUpperCase() === 'USA' ? 'US' : raw.toUpperCase();
    if (/^[a-z]{2}$/i.test(raw) && countries.isValid(raw.toUpperCase())) return raw.toUpperCase();
    return countries.getAlpha2Code(raw, 'en') || null;
  },
  normalizeLocationText,
  hasUnambiguousForeignCountryEvidence,
  isBareGenericRemoteTerm,
  isBareAmbiguousForeignCityName,
  hasExplicitUsLanguageEvidence,
};
