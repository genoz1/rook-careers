// backend/testJobEligibility.js
// Run: node backend/testJobEligibility.js
//
// Covers the three new/changed modules from the US-job-eligibility
// project: locationTextRules.js (shared pure text checks), 
// jobEligibility.js (the centralized, pure, network-free eligibility
// gate), and geocoding.js's pre-check/category-validation logic (tested
// via a mocked global.fetch — no real Nominatim calls are made by this
// suite, consistent with every other check in this project having
// already been validated against real, live diagnostic output earlier).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  hasUnambiguousForeignCountryEvidence,
  isBareGenericRemoteTerm,
  isBareAmbiguousForeignCityName,
  hasExplicitUsLanguageEvidence,
} = require("./locationTextRules");
const { isUsEligibleJob, resolveUsStateCode, US_ELIGIBLE_STATE_CODES } = require("./jobEligibility");
const { extractGeocodableLocation } = require("./locationExtraction");
const { validateDryRunReport } = require("./backfillReportValidation");
const { parseExplicitState } = require("./scripts/repairRemoteOfficeCluster");

let passCount = 0;
let failCount = 0;
function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function run() {
  console.log("\n=== locationTextRules.js: hasUnambiguousForeignCountryEvidence — real known-bad records ===");

  // The 9 unique bare-country-name inputs actually confirmed live
  // against Nominatim in this project (10 records — "Zambia" appears
  // twice) — every one of these must be rejected before geocoding is
  // even attempted.
  const CONFIRMED_BAD_INPUTS = ["Tanzania", "Kuwait", "Zimbabwe", "Cameroon", "Senegal", "Kazakhstan", "Zambia", "Mozambique"];
  for (const input of CONFIRMED_BAD_INPUTS) {
    test(`"${input}" is flagged as unambiguous foreign evidence`, () => {
      assert.strictEqual(hasUnambiguousForeignCountryEvidence(input), true);
    });
  }

  test('"Panama, Panamá, Panama" (the 10th confirmed-bad record) is flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Panama, Panamá, Panama"), true);
  });

  console.log("\n=== locationTextRules.js: Georgia special-casing (direct instruction) ===");

  test('bare "Georgia" defaults to the US state — NOT flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Georgia"), false);
  });

  test('"Atlanta, Georgia, United States" (real record) is NOT flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Atlanta, Georgia, United States"), false);
  });

  test('"United States Remote Office | Georgia, USA" (real record) is NOT flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("United States Remote Office | Georgia, USA"), false);
  });

  test('"Tbilisi, Georgia" IS flagged as foreign (affirmative foreign context)', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Tbilisi, Georgia"), true);
  });

  test('"Country of Georgia" IS flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Sales Manager - Country of Georgia"), true);
  });

  test('"Georgia, Europe" IS flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Georgia, Europe"), true);
  });

  test('"Caucasus region (Georgia)" IS flagged as foreign', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Caucasus region (Georgia)"), true);
  });

  console.log("\n=== locationTextRules.js: foreign evidence overrides a conflicting US phrase ===");

  test('"United States / Canada" is flagged as foreign — Canada wins despite "United States" being present', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("United States / Canada"), true);
  });

  test('"Sales Manager - United States, Canada, Mexico" is flagged as foreign (Canada present)', () => {
    assert.strictEqual(hasUnambiguousForeignCountryEvidence("Sales Manager - United States, Canada, Mexico"), true);
  });

  console.log("\n=== locationTextRules.js: genuine US locations are never flagged as foreign ===");

  const REAL_GOOD_INPUTS = [
    "Boston, MA", "Chicago", "California", "Washington, District of Columbia, USA",
    "San Juan, Puerto Rico", "United States Remote Office | California, USA",
    "Field Sales (USA)", "United States - Field Based", "US Territory Field based",
    "Orlando", "Baltimore",
  ];
  for (const input of REAL_GOOD_INPUTS) {
    test(`"${input}" is NOT flagged as foreign`, () => {
      assert.strictEqual(hasUnambiguousForeignCountryEvidence(input), false);
    });
  }

  console.log("\n=== locationTextRules.js: isBareGenericRemoteTerm ===");

  test('"Remote" alone is a bare generic term — proven necessary (resolves to a real hamlet in Coos County, OR)', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Remote"), true);
  });
  test('"Remote (WFH)" is a bare generic term', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Remote (WFH)"), true);
  });
  test('"WFH" alone is a bare generic term', () => {
    assert.strictEqual(isBareGenericRemoteTerm("WFH"), true);
  });
  test('"Virtual" alone is a bare generic term', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Virtual"), true);
  });
  test('"Telecommute" alone is a bare generic term', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Telecommute"), true);
  });
  test('"United States Remote Office | California, USA" is NOT a bare generic term (has real location content)', () => {
    assert.strictEqual(isBareGenericRemoteTerm("United States Remote Office | California, USA"), false);
  });
  test('"Remote - Georgia" is NOT a bare generic term (names a specific state)', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Remote - Georgia"), false);
  });
  test('"Boston, MA" is NOT a bare generic term', () => {
    assert.strictEqual(isBareGenericRemoteTerm("Boston, MA"), false);
  });

  console.log("\n=== locationTextRules.js: hasExplicitUsLanguageEvidence — real confirmed-necessary patterns ===");

  const REAL_FALLBACK_PATTERNS = ["United States Remote Office | California, USA", "Field Sales (USA)", "United States - Field Based", "US Territory Field based"];
  for (const input of REAL_FALLBACK_PATTERNS) {
    test(`"${input}" carries explicit US-language evidence (confirmed: returns 0 Nominatim results, needs this fallback)`, () => {
      assert.strictEqual(hasExplicitUsLanguageEvidence(input), true);
    });
  }
  test('bare "Remote" carries NO explicit US-language evidence on its own', () => {
    assert.strictEqual(hasExplicitUsLanguageEvidence("Remote"), false);
  });
  test('"Munich" carries no explicit US-language evidence', () => {
    assert.strictEqual(hasExplicitUsLanguageEvidence("Munich"), false);
  });

  console.log("\n=== jobEligibility.js: resolveUsStateCode — complete, independent allowlist ===");

  test("all 50 states resolve by full name", () => {
    const fullNames = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"];
    for (const name of fullNames) {
      assert.ok(resolveUsStateCode(name), `expected "${name}" to resolve to a code`);
    }
    assert.strictEqual(fullNames.length, 50);
  });

  test('"District of Columbia" resolves to "DC"', () => {
    assert.strictEqual(resolveUsStateCode("District of Columbia"), "DC");
  });
  test('"Puerto Rico" resolves to "PR"', () => {
    assert.strictEqual(resolveUsStateCode("Puerto Rico"), "PR");
  });
  test('"Guam" resolves to "GU"', () => {
    assert.strictEqual(resolveUsStateCode("Guam"), "GU");
  });
  test('"U.S. Virgin Islands" resolves to "VI"', () => {
    assert.strictEqual(resolveUsStateCode("U.S. Virgin Islands"), "VI");
  });
  test('"American Samoa" resolves to "AS"', () => {
    assert.strictEqual(resolveUsStateCode("American Samoa"), "AS");
  });
  test('"Northern Mariana Islands" resolves to "MP"', () => {
    assert.strictEqual(resolveUsStateCode("Northern Mariana Islands"), "MP");
  });
  test("a real 2-letter code in the allowlist (\"FL\") resolves", () => {
    assert.strictEqual(resolveUsStateCode("FL"), "FL");
  });
  test('a real 2-letter territory code ("PR") resolves case-insensitively ("pr")', () => {
    assert.strictEqual(resolveUsStateCode("pr"), "PR");
  });

  console.log("\n=== jobEligibility.js: resolveUsStateCode REJECTS arbitrary 2-letter strings (the exact gap matching.js's stateAbbrFromName has) ===");

  test('a 2-letter string that is NOT a real state/territory code ("ZZ") does NOT resolve', () => {
    // This is the specific, direct-instruction-driven difference from
    // matching.js's stateAbbrFromName(), which would blindly accept
    // "ZZ" as if it were valid. Confirms this module does not inherit
    // that gap.
    assert.strictEqual(resolveUsStateCode("ZZ"), null);
  });
  test('a 2-letter string that looks state-like but isn\'t ("XX") does NOT resolve', () => {
    assert.strictEqual(resolveUsStateCode("XX"), null);
  });
  test("a foreign country's own 2-letter ISO code that happens to be 2 letters (\"KW\" for Kuwait) does NOT resolve", () => {
    assert.strictEqual(resolveUsStateCode("KW"), null);
  });
  test("null/empty/garbage input resolves to null, not a crash", () => {
    assert.strictEqual(resolveUsStateCode(null), null);
    assert.strictEqual(resolveUsStateCode(""), null);
    assert.strictEqual(resolveUsStateCode("   "), null);
    assert.strictEqual(resolveUsStateCode("Not A Real Place"), null);
  });

  test("US_ELIGIBLE_STATE_CODES has exactly 56 entries (50 states + DC + 5 territories)", () => {
    assert.strictEqual(US_ELIGIBLE_STATE_CODES.size, 56);
  });

  console.log("\n=== jobEligibility.js: isUsEligibleJob — the actual production decision, end to end ===");

  test("real coordinates + a resolvable state -> ELIGIBLE", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: 42.35, job_lng: -71.05, state: "Massachusetts", location_raw: "Boston, MA" }), true);
  });

  test("real coordinates + DC as state -> ELIGIBLE (the specific gap this project closed)", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: 38.89, job_lng: -77.03, state: "District of Columbia", location_raw: "Washington, DC" }), true);
  });

  test("real coordinates + Puerto Rico as state -> ELIGIBLE", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: 18.38, job_lng: -66.05, state: "Puerto Rico", location_raw: "San Juan, Puerto Rico" }), true);
  });

  test("a fresh free account's brand-new profile fields (no job data) don't crash isUsEligibleJob when called with a null job", () => {
    assert.strictEqual(isUsEligibleJob(null), false);
  });

  test("the 10 known-bad records (once corrected: coordinates AND state nulled) are EXCLUDED, not left wrongly eligible", () => {
    const correctedBadRecord = { job_lat: null, job_lng: null, state: null, location_raw: "Tanzania" };
    assert.strictEqual(isUsEligibleJob(correctedBadRecord), false);
  });

  test("the 10 known-bad records in their CURRENT (uncorrected) state — real coords, but state null — are ALSO correctly excluded, since state alone is what step 1 requires", () => {
    // This directly demonstrates why the correction step matters: even
    // before the 10 records are explicitly corrected, isUsEligibleJob
    // already excludes them today, because state has always been null.
    // The correction (nulling job_lat/job_lng too) is about data
    // hygiene and preventing a stale, incorrect distance from ever
    // being computed elsewhere — not about eligibility, which was
    // already correctly false.
    const uncorrectedBadRecord = { job_lat: 38.9061022, job_lng: -77.0491254, state: null, location_raw: "Tanzania" };
    assert.strictEqual(isUsEligibleJob(uncorrectedBadRecord), false);
  });

  test("no coordinates, no state, explicit US field-language -> ELIGIBLE via fallback", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "United States - Field Based" }), true);
  });

  test("no coordinates, no state, bare 'Remote' -> EXCLUDED (unresolved, not assumed American)", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "Remote" }), false);
  });

  test("no coordinates, no state, a foreign remote job -> EXCLUDED", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "Remote - Germany" }), false);
  });

  test("conflicting location text ('United States / Canada'), no coordinates -> EXCLUDED (foreign evidence overrides the US-language fallback)", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "United States / Canada" }), false);
  });

  test("a genuinely foreign city (Munich), no coordinates -> EXCLUDED", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "Field Worker - DEU (Munich)" }), false);
  });

  test("no coordinates, no state, no US language, no foreign evidence ('2 Locations' placeholder) -> EXCLUDED as unresolved", () => {
    assert.strictEqual(isUsEligibleJob({ job_lat: null, job_lng: null, state: null, location_raw: "2 Locations" }), false);
  });

  console.log("\n=== jobEligibility.js: temporary quarantine for confirmed bad-location records ===");

  test("first Barcelona, Spain record remains excluded even with valid-looking New York coordinates/state", () => {
    const job = {
      id: "226f8b0f-6577-478c-9c50-e369e8cf18c6",
      job_lat: 42.0740813,
      job_lng: -79.4924188,
      state: "New York",
      location_raw: "Barcelona",
    };
    assert.strictEqual(isUsEligibleJob(job), false);
  });

  test("second Barcelona, Spain record remains excluded even with valid-looking New York coordinates/state", () => {
    const job = {
      id: "93402f62-4c5d-456e-af08-c11132958f1b",
      job_lat: 42.0740813,
      job_lng: -79.4924188,
      state: "New York",
      location_raw: "Barcelona",
    };
    assert.strictEqual(isUsEligibleJob(job), false);
  });

  test("Nashua record remains excluded even with valid-looking New Hampshire coordinates/state", () => {
    const job = {
      id: "9e4116c4-a3c8-448b-b733-d3468b92f9f9",
      job_lat: 45.2838212,
      job_lng: -71.1020442,
      state: "New Hampshire",
      location_raw: "Remote, NH | Nashua, New Hampshire",
    };
    assert.strictEqual(isUsEligibleJob(job), false);
  });

  console.log("\n=== jobEligibility.js: unambiguous foreign evidence wins even with valid-looking US coordinates/state (ordering fix) ===");

  test("Tanzania with valid-looking DC coordinates AND a resolvable DC state is STILL excluded", () => {
    // This is exactly the shape the 10 known-bad records originally
    // had: real, plausible coordinates and a real, resolvable US state
    // name, sitting alongside a job whose own location text plainly
    // names a foreign country. Foreign evidence must win regardless.
    const job = { job_lat: 38.9061022, job_lng: -77.0491254, state: "District of Columbia", location_raw: "Tanzania" };
    assert.strictEqual(isUsEligibleJob(job), false);
  });

  test('"United States / Canada" with valid-looking US coordinates AND a resolvable state is STILL excluded', () => {
    const job = { job_lat: 44.5, job_lng: -89.5, state: "Wisconsin", location_raw: "United States / Canada" };
    assert.strictEqual(isUsEligibleJob(job), false);
  });

  console.log("\n=== geocoding.js: pre-checks and category validation (mocked fetch — no real network calls) ===");



  // These tests mock global.fetch to (a) prove the two pre-checks
  // short-circuit BEFORE any network call is made at all, and (b) prove
  // the post-fetch category validation correctly accepts/rejects based
  // on the exact `category` values confirmed via real, live Nominatim
  // testing earlier in this project.
  const originalFetch = global.fetch;
  function installFetchStub(shouldBeCalled, responseBody) {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      return { ok: true, json: async () => responseBody };
    };
    return () => {
      global.fetch = originalFetch;
      return callCount;
    };
  }

  await asyncTest("geocodeLocation NEVER calls fetch for a bare foreign country name (pre-check short-circuits)", async () => {
    const restore = installFetchStub();
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("Tanzania");
    const callCount = restore();
    assert.strictEqual(callCount, 0, "fetch must not be called at all for a pre-check-rejected input");
    assert.strictEqual(result, null);
  });

  await asyncTest("geocodeLocation NEVER calls fetch for a bare generic remote term (pre-check short-circuits)", async () => {
    const restore = installFetchStub();
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("Remote");
    const callCount = restore();
    assert.strictEqual(callCount, 0);
    assert.strictEqual(result, null);
  });

  await asyncTest("geocodeLocation REJECTS a real embassy-category result (the actual confirmed shape of the Kuwait bug)", async () => {
    const restore = installFetchStub(true, [{
      lat: "38.9405905", lon: "-77.0591931", category: "office", type: "diplomatic",
      address: { state: "District of Columbia" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    // "Kuwait City" isn't itself a bare country name, so it passes the
    // pre-check and reaches the mocked fetch/category-validation step —
    // this specifically tests the POST-geocode category rejection.
    const result = await geocodeLocation("Kuwait City");
    restore();
    assert.strictEqual(result, null, "an office/diplomatic-category result must be rejected regardless of what triggered the query");
  });

  await asyncTest("geocodeLocation ACCEPTS a real place-category result (Washington DC's actual confirmed shape)", async () => {
    const restore = installFetchStub(true, [{
      lat: "38.8950982", lon: "-77.0363849", category: "place", type: "city",
      address: { state: "District of Columbia" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("Washington, District of Columbia, USA");
    restore();
    assert.deepStrictEqual(result, { lat: 38.8950982, lng: -77.0363849, state: "District of Columbia" });
  });

  await asyncTest("geocodeLocation ACCEPTS a real boundary-category result (Boston's actual confirmed shape)", async () => {
    const restore = installFetchStub(true, [{
      lat: "42.3588336", lon: "-71.0578303", category: "boundary", type: "administrative",
      address: { state: "Massachusetts" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("Boston, MA");
    restore();
    assert.deepStrictEqual(result, { lat: 42.3588336, lng: -71.0578303, state: "Massachusetts" });
  });

  await asyncTest("geocodeLocation REJECTS a highway-category result (the actual confirmed shape of the 'Zambia Drive' false positive)", async () => {
    const restore = installFetchStub(true, [{
      lat: "30.4726416", lon: "-97.8553599", category: "highway", type: "residential",
      address: { state: "Texas" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null);
  });

  await asyncTest("geocodeLocation REJECTS a building-category result (the actual confirmed shape of the 'Zimbabwe House' false positive)", async () => {
    const restore = installFetchStub(true, [{
      lat: "40.7602869", lon: "-73.9702912", category: "building", type: "yes",
      address: { state: "New York" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null);
  });

  await asyncTest("geocodeLocation REJECTS a water/waterway-category result (the actual confirmed shape of the 'Lake Senegal Yeaton' false positive)", async () => {
    const restore = installFetchStub(true, [{
      lat: "38.2467233", lon: "-122.7860267", category: "water", type: "lake",
      address: { state: "California" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null);
  });

  await asyncTest("geocodeLocation REJECTS a place/boundary-category result with NO state in the address at all (missing state)", async () => {
    const restore = installFetchStub(true, [{
      lat: "40.0", lon: "-100.0", category: "boundary", type: "administrative",
      address: {}, // no state field at all
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null, "a result with no state at all must be rejected, even if category is acceptable");
  });

  await asyncTest("geocodeLocation REJECTS a place/boundary-category result whose state does NOT resolve through the allowlist (invalid state)", async () => {
    const restore = installFetchStub(true, [{
      lat: "43.6532", lon: "-79.3832", category: "boundary", type: "administrative",
      address: { state: "Ontario" }, // a real place, but not a US state/DC/territory
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null, "a category-acceptable result with a non-US state value must still be rejected");
  });

  await asyncTest("geocodeLocation REJECTS non-finite coordinates even with an otherwise-acceptable category and state", async () => {
    const restore = installFetchStub(true, [{
      lat: "not-a-number", lon: "-77.0", category: "place", type: "city",
      address: { state: "Virginia" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null, "a non-finite latitude must be rejected regardless of category/state");
  });

  await asyncTest("geocodeLocation REJECTS a missing longitude field entirely", async () => {
    const restore = installFetchStub(true, [{
      lat: "38.9", category: "place", type: "city", // lon field entirely absent
      address: { state: "Virginia" },
    }]);
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("some ambiguous input");
    restore();
    assert.strictEqual(result, null);
  });

  console.log("\n=== locationTextRules.js: isBareAmbiguousForeignCityName (durable Barcelona fix) ===");

  test('"Barcelona" alone is flagged as an ambiguous bare foreign city name', () => {
    assert.strictEqual(isBareAmbiguousForeignCityName("Barcelona"), true);
  });
  test('"barcelona" (lowercase) is still flagged, case-insensitively', () => {
    assert.strictEqual(isBareAmbiguousForeignCityName("barcelona"), true);
  });
  test('"Barcelona, NY" is NOT flagged — a qualified string is not the confirmed bare-ambiguous shape', () => {
    assert.strictEqual(isBareAmbiguousForeignCityName("Barcelona, NY"), false);
  });
  test('"Barcelona, Spain" is NOT flagged by this check specifically (it would be caught by the country-evidence check instead)', () => {
    assert.strictEqual(isBareAmbiguousForeignCityName("Barcelona, Spain"), false);
  });
  test('"Boston" is NOT flagged (not on the narrow, confirmed list)', () => {
    assert.strictEqual(isBareAmbiguousForeignCityName("Boston"), false);
  });

  await asyncTest("geocodeLocation NEVER calls fetch for bare \"Barcelona\" (durable fix — confirmed real record, prevents recreating the Barcelona/NY coordinate on future re-ingestion)", async () => {
    const restore = installFetchStub();
    delete require.cache[require.resolve("./geocoding")];
    const { geocodeLocation } = require("./geocoding");
    const result = await geocodeLocation("Barcelona");
    const callCount = restore();
    assert.strictEqual(callCount, 0, "fetch must not be called at all for the confirmed bare-ambiguous city name");
    assert.strictEqual(result, null);
  });

  console.log("\n=== locationExtraction.js: extractGeocodableLocation (durable Nashua fix) ===");

  test('"Remote, NH | Nashua, New Hampshire" (the real Nashua record) extracts the more specific second segment', () => {
    assert.strictEqual(extractGeocodableLocation("Remote, NH | Nashua, New Hampshire"), "Nashua, New Hampshire");
  });

  test('a bare "Remote, TX" with NO second segment is left unchanged — the narrow fix only triggers with a more specific second segment present', () => {
    assert.strictEqual(extractGeocodableLocation("Remote, TX"), "Remote, TX");
  });

  test('"Remote, NH | 2 Locations" (second segment not a real city+state shape) is left as the first segment, not force-substituted', () => {
    assert.strictEqual(extractGeocodableLocation("Remote, NH | 2 Locations"), "Remote, NH");
  });

  test("the separate 172-record cluster shape (\"United States Remote Office | Texas, USA\") is NOT affected by this narrow fix — different first-segment shape entirely, explicitly out of scope", () => {
    // "United States Remote Office" does not match the bare "Remote, XX"
    // pattern this fix targets, so it falls through unchanged to the
    // existing (unmodified) extraction logic — confirming this project
    // did not broadly redesign all pipe-delimited records.
    assert.strictEqual(extractGeocodableLocation("United States Remote Office | Texas, USA"), "United States Remote Office | Texas, USA".split("|")[0].trim());
  });

  test('"Remote - Georgia" (dash, not the "Remote, XX" comma+2-letter shape) is unaffected by this fix', () => {
    assert.strictEqual(extractGeocodableLocation("Remote - Georgia"), "Georgia");
  });

  console.log("\n=== repairRemoteOfficeCluster.js: exact US region parsing ===");

  test('"West Virginia" is not misclassified as Virginia', () => {
    assert.strictEqual(
      parseExplicitState("United States Remote Office | West Virginia, USA"),
      "West Virginia"
    );
  });

  test('"Virginia" still parses correctly', () => {
    assert.strictEqual(
      parseExplicitState("United States Remote Office | Virginia, USA"),
      "Virginia"
    );
  });

  test('"District of Columbia" is supported', () => {
    assert.strictEqual(
      parseExplicitState("United States Remote Office | District of Columbia, USA"),
      "District of Columbia"
    );
  });

  test('"Puerto Rico" is supported', () => {
    assert.strictEqual(
      parseExplicitState("United States Remote Office | Puerto Rico, USA"),
      "Puerto Rico"
    );
  });

  test("all five US territories are supported by exact name", () => {
    for (const territory of [
      "Puerto Rico",
      "Guam",
      "U.S. Virgin Islands",
      "American Samoa",
      "Northern Mariana Islands",
    ]) {
      assert.strictEqual(
        parseExplicitState(`United States Remote Office | ${territory}, USA`),
        territory
      );
    }
  });

  test("region-like words embedded in prose are not guessed", () => {
    assert.strictEqual(
      parseExplicitState("United States Remote Office | West Virginia University, USA"),
      null
    );
  });

  console.log("\n=== backfillReportValidation.js: validateDryRunReport (pure, no I/O) ===");

  function makeValidReport(overrides = {}) {
    return {
      mode: "dry-run",
      entries: [
        { job_id: "11111111-1111-1111-1111-111111111111", proposed_state: "CA", matched_fips: "06", current_job_lat: "34.0", current_job_lng: "-118.0", current_state: null },
        { job_id: "22222222-2222-2222-2222-222222222222", proposed_state: null, matched_fips: null, current_job_lat: null, current_job_lng: null, current_state: null },
      ],
      ...overrides,
    };
  }

  test("a well-formed dry-run report validates OK", () => {
    const result = validateDryRunReport(makeValidReport());
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  test('a report with mode "write" (not "dry-run") is rejected', () => {
    const result = validateDryRunReport(makeValidReport({ mode: "write" }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('mode')));
  });

  test("a report with a duplicate job_id is rejected", () => {
    const report = makeValidReport();
    report.entries.push({ ...report.entries[0] });
    const result = validateDryRunReport(report);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("duplicate")));
  });

  test("a report with an invalid proposed_state (not in the allowlist) is rejected", () => {
    const report = makeValidReport();
    report.entries[0].proposed_state = "ZZ";
    const result = validateDryRunReport(report);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("invalid proposed_state")));
  });

  test("a report where proposed_state and matched_fips disagree is rejected", () => {
    const report = makeValidReport();
    report.entries[0].matched_fips = "36"; // NY, not CA — inconsistent with proposed_state "CA"
    const result = validateDryRunReport(report);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("does not match FIPS")));
  });

  test("a report with entries that isn't an array is rejected", () => {
    const result = validateDryRunReport({ mode: "dry-run", entries: "not-an-array" });
    assert.strictEqual(result.valid, false);
  });

  test("a completely malformed input (null) is rejected without throwing", () => {
    const result = validateDryRunReport(null);
    assert.strictEqual(result.valid, false);
  });

  console.log("\n=== REGRESSION: publicPages.js wires isUsEligibleJob into every route that could expose a job to Google/visitors ===");

  test("publicPages.js imports isUsEligibleJob", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "publicPages.js"), "utf8");
    assert.ok(/require\(["']\.\.\/jobEligibility["']\)/.test(src), "publicPages.js must import isUsEligibleJob from jobEligibility.js");
  });

  test("the /jobs/:id public job-detail route rejects an ineligible job (real incident: a Wuhan, China posting was previously served here unfiltered)", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "publicPages.js"), "utf8");
    assert.ok(/error \|\| !job \|\| !isUsEligibleJob\(job\)/.test(src), "the job-detail route must reject when isUsEligibleJob(job) is false, not just on a missing/errored row");
  });

  test("the /sitemap.xml route filters jobs through isUsEligibleJob before listing them (real incident: this exact route is how Google discovered the Wuhan posting)", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "publicPages.js"), "utf8");
    assert.ok(/allJobs\.filter\(isUsEligibleJob\)/.test(src), "sitemap job URLs must be filtered through isUsEligibleJob");
  });

  test("the /jobs/:id route's 'similar jobs' internal links are also filtered through isUsEligibleJob", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "publicPages.js"), "utf8");
    assert.ok(/\(similarRaw \|\| \[\]\)\.filter\(isUsEligibleJob\)/.test(src), "similar-job internal links must not surface an ineligible job either");
  });

  console.log("\n=== REGRESSION: jobs.js wires isUsEligibleJob into every candidate-facing response path ===");

  test("jobs.js imports isUsEligibleJob and no longer imports or calls the older mentionsNonUsCountry", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "jobs.js"), "utf8");
    assert.ok(/require\(["']\.\.\/jobEligibility["']\)/.test(src), "jobs.js must import isUsEligibleJob from jobEligibility.js");
    assert.ok(!/mentionsNonUsCountry\(/.test(src), "the older, less complete mentionsNonUsCountry check should no longer be CALLED anywhere (a comment referencing the old name for context is fine)");
    assert.ok(!/\{[^}]*mentionsNonUsCountry[^}]*\}\s*=\s*require/.test(src), "mentionsNonUsCountry should no longer be imported at all");
  });

  test("GET /jobs/:id returns 404 for an ineligible job (real incident: reachable here before this gate existed)", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "jobs.js"), "utf8");
    assert.ok(/if \(!isUsEligibleJob\(data\)\)/.test(src), "the single-job route must check isUsEligibleJob(data) and reject before returning any job fields");
  });

  test("every job-list response path in jobs.js filters through isUsEligibleJob", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "jobs.js"), "utf8");
    const matches = src.match(/\.filter\(isUsEligibleJob\)|\.filter\(\(job\) => isUsEligibleJob|\.filter\(\(row\) => isUsEligibleJob/g) || [];
    // Ten known call sites as of this change: the anonymous fallback,
    // the anonymous explore path, the authenticated explore path, both
    // GET /jobs response branches, /recruiter-jobs, /new-matches-today-
    // count, /saved-jobs, and one more list-building spot. A regression
    // that drops any of these should fail this count, not silently pass.
    assert.ok(matches.length >= 10, `expected at least 10 isUsEligibleJob filter call sites in jobs.js, found ${matches.length}`);
  });

  test("GET /new-matches-today-count selects every field isUsEligibleJob needs (id, job_lat, job_lng, state, location_raw) — real bug this guards: job_lat/state were missing, so hasCoordinates was always false regardless of real data", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "jobs.js"), "utf8");
    const routeMatch = src.match(/router\.get\("\/new-matches-today-count"[\s\S]*?\.select\("([^"]+)"\)/);
    assert.ok(routeMatch, "could not find the /new-matches-today-count route's select() call");
    const selected = routeMatch[1].split(",").map((s) => s.trim());
    for (const field of ["id", "job_lat", "job_lng", "state", "location_raw"]) {
      assert.ok(selected.includes(field), `/new-matches-today-count must select "${field}" for isUsEligibleJob to work correctly`);
    }
  });

  test("GET /sitemap.xml paginates through all active jobs rather than capping at a single page before eligibility filtering", () => {
    const src = fs.readFileSync(path.join(__dirname, "routes", "publicPages.js"), "utf8");
    const sitemapSection = src.slice(src.indexOf('router.get("/sitemap.xml"'));
    assert.ok(/\.range\(from, from \+ PAGE_SIZE - 1\)/.test(sitemapSection), "the sitemap route must paginate via .range() rather than a single .limit() call");
    assert.ok(!/\.limit\(5000\)/.test(sitemapSection), "the old hard .limit(5000) cap (applied before eligibility filtering) must be gone");
  });

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
