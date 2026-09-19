// Workday CXS (Career Site) API adapter
//
// Public, unauthenticated endpoint — no signup, no API key required. This
// is the same API that powers the search box on a company's own public
// Workday careers site, so it's meant to be called from outside code.
//
// NOTE: unlike the Greenhouse/Lever/Ashby adapters, this one has not been
// tested against a live Workday endpoint — the sandbox this was written in
// can't reach myworkdayjobs.com. It's built to Workday's well-documented
// public API shape, but treat the first real ingestion run against each
// new Workday employer as the real test.
//
// You need three pieces of information per employer, all visible in their
// careers site URL:
//   https://{tenant}.{wdNumber}.myworkdayjobs.com/{site}
//   e.g. https://idexx.wd1.myworkdayjobs.com/IDEXX
//        tenant = "idexx", wdNumber = "wd1", site = "IDEXX"
//
// Store all three in the employers.ats_identifier column as a single
// pipe-delimited string: "tenant|wdNumber|site"
//   e.g. "idexx|wd1|IDEXX"

function parseWorkdayIdentifier(identifier) {
  const parts = (identifier || "").split("|");
  const [tenant, wdNumber, site] = parts;
  if (!tenant || !wdNumber || !site) {
    throw new Error(
      `Malformed Workday ats_identifier "${identifier}" — expected "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"`
    );
  }
  return { tenant, wdNumber, site };
}

/**
 * Fetch all currently published jobs for one employer's Workday site,
 * including full descriptions. Workday paginates in batches (20 by
 * default); this walks every page, then fetches each job's detail page
 * separately since the list endpoint doesn't include full descriptions.
 *
 * @param {string} identifier - "tenant|wdNumber|site", e.g. "idexx|wd1|IDEXX"
 */

// Same relevance filter used in ingest.js — applied here as a pre-filter
// before fetching each job's full detail page, since detail fetches are
// the slow part (one request per job, done sequentially). For a large
// employer (Labcorp, IDEXX, etc. can have hundreds of postings), fetching
// full descriptions for obviously-irrelevant jobs (warehouse, lab tech,
// packaging) wastes most of the run's time on titles that will just get
// filtered out afterward anyway.
const { titleLooksRelevant } = require('../relevanceFilter');
const zipcodes = require('zipcodes');
const { resolveUsStateCode } = require('../jobEligibility');

// Workday commonly publishes field roles as "State - Virtual" even when
// the posting title names the actual territory city. Use that city only
// when a real US ZIP record proves it belongs to the source-provided state.
// This keeps location inference deterministic and rejects labels such as
// "West Region" or ambiguous "City A or City B" territories.
function validatedVirtualCity(title, location) {
  const match = String(location || '').trim().match(/^([A-Za-z .]+?)\s*[-–]\s*Virtual$/i);
  if (!match || /\bor\b|\bregion\b/i.test(title || '')) return null;
  const state = resolveUsStateCode(match[1]);
  if (!state) return null;
  let tail = String(title || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  tail = tail.replace(new RegExp(`[, ]+${state}$`, 'i'), '').trim();
  const words = tail.split(/\s+/);
  for (let size = Math.min(4, words.length); size >= 1; size--) {
    let city = words.slice(-size).join(' ').replace(/^[,–—-]+|[,–—-]+$/g, '').trim();
    if (/ City$/i.test(city)) city = city.replace(/ City$/i, '');
    if (city && zipcodes.lookupByName(city, state).length) return `${city}, ${state}`;
  }
  return null;
}

// Wraps fetch() with a timeout so one stalled request can't hang the
// entire ingestion run forever — without this, a single unresponsive
// endpoint blocks every job after it indefinitely.
// Diagnosed via a live diagnostic run (Sept 2026): every single Workday
// employer (9 different tenants, all correct identifiers) failed with
// the identical generic "422 Unprocessable Entity" + empty message +
// unique error case ID — that uniformity across unrelated tenants points
// to Workday's own request-validation layer rejecting the request
// itself, not 9 coincidentally-wrong database entries. Reference
// material on working Workday scrapers confirms the request needs a
// User-Agent and a Referer header that mirrors the real careers-page
// origin (the page a candidate would actually be browsing when their
// browser makes this same call) — this adapter previously sent neither.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkdayJobs(identifier) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const refererUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/${site}`;

  const allPostings = [];
  const pageSize = 20;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const res = await fetchWithTimeout(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: refererUrl },
      body: JSON.stringify({ appliedFacets: {}, limit: pageSize, offset, searchText: "" }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(
        `Workday fetch failed for "${identifier}": ${res.status} ${res.statusText}` +
          (bodyText ? ` — ${bodyText.slice(0, 300)}` : "")
      );
    }
    const data = await res.json();
    if (!Array.isArray(data?.jobPostings) || (offset === 0 && (!Number.isInteger(data.total) || data.total < 0))) {
      throw new Error("Workday incomplete extraction: malformed listing response");
    }
    if (data.jobPostings.some(p => !p || !p.externalPath || typeof p.title !== 'string')) throw new Error("Workday malformed posting");
    // Only trust a new total if it's a real positive number — some
    // Workday tenants omit or zero out `total` on paginated (non-first)
    // requests, which was silently truncating results to just the first
    // couple pages for several employers (Covetrus, Elanco, Cardinal
    // Health, MWI all stopped at 40 jobs regardless of their real count).
    if (typeof data.total === "number" && data.total > 0) {
      total = total === Infinity ? data.total : Math.max(total, data.total);
    }
    if (offset === 0 && data.total === 0) total = 0;
    if (data.jobPostings.length === 0 && offset < total) throw new Error("Workday incomplete extraction: premature empty page");
    allPostings.push(...data.jobPostings);
    if (new Set(allPostings.map(p => p.externalPath)).size !== allPostings.length) throw new Error("Workday incomplete extraction: duplicate pagination");
    offset += data.jobPostings.length;
    console.log(`    ...listed ${allPostings.length} / ${total} postings`);

    // Safety cap so a very large employer (or an unexpected API response)
    // can't loop forever.
    if (offset > 2000 && offset < total) throw new Error("Workday incomplete extraction: pagination safety limit reached");
  }

  // Only fetch full detail for postings that already look relevant by
  // title — see titleLooksRelevant() above for why. This is the slow part
  // (one request per job, sequential), so it logs progress every 10 jobs.
  const relevantPostings = allPostings.filter((p) => titleLooksRelevant(p.title));
  console.log(`    ${relevantPostings.length} / ${allPostings.length} titles look relevant — fetching their descriptions...`);

  const detailed = [];
  for (let i = 0; i < relevantPostings.length; i++) {
    const posting = relevantPostings[i];
    {
      const detailRes = await fetchWithTimeout(`${baseUrl}${posting.externalPath}`);
      if (!detailRes.ok) throw new Error(`Workday detail fetch failed: ${detailRes.status}`);
      const detail = await detailRes.json();
      if (!detail?.jobPostingInfo || typeof detail.jobPostingInfo !== "object") throw new Error("Workday malformed detail response");
      detailed.push({ ...posting, detail });
    }
    if ((i + 1) % 10 === 0 || i === relevantPostings.length - 1) {
      console.log(`    ...fetched details for ${i + 1} / ${relevantPostings.length}`);
    }
  }

  return detailed;
}

/**
 * Convert one raw Workday job (list entry + detail merged) into ROOK's
 * canonical job shape.
 */
// Some Workday tenants are shared across many operating companies under
// one parent (Danaher, Johnson & Johnson, Envista, Owens & Minor are all
// like this in ROOK's employer list) - a single tenant's postings can
// belong to any of several real, separately-recognizable brands. Rather
// than attributing every job to the generic parent name, this checks the
// job's own description for a known child-brand mention and uses that
// instead when found, since candidates care which actual company they'd
// be working for. Falls back to the employer's stored name for the large
// majority of employers, which aren't shared tenants at all.
const SHARED_TENANT_BRANDS = {
  danaher: [
    "Beckman Coulter", "Cepheid", "Leica Biosystems", "Leica Microsystems",
    "SCIEX", "Pall Corporation", "Molecular Devices", "Radiometer", "Cytiva",
  ],
  jj: [
    "DePuy Synthes", "Johnson & Johnson Innovative Medicine", "Johnson & Johnson MedTech",
  ],
  envista: [
    "DEXIS", "Kerr", "Nobel Biocare", "Ormco",
  ],
  owensminor: [
    "Apria", "Byram Healthcare",
  ],
  mars: [
    "Royal Canin", "Wisdom Panel", "Mars Veterinary Health", "Banfield Pet Hospital",
    "BluePearl", "AniCura", "Linnaeus", "Antech",
  ],
  msd: [
    "Merck Animal Health",
  ],
  baxter: [
    "Vantive",
  ],
};

function extractChildBrand(tenant, text) {
  const brands = SHARED_TENANT_BRANDS[tenant.toLowerCase()];
  if (!brands || !text) return null;
  for (const brand of brands) {
    if (text.includes(brand)) return brand;
  }
  return null;
}

// Mirrors backend/matching.js's NON_US_COUNTRY_SIGNALS list (kept as
// full names there since that list also matches free-text location
// strings) - translates Workday's ISO alpha-2 country code into a name
// that detector already recognizes, only for countries actually on
// that list, since matches nowhere else in the pipeline check for any
// other code anyway.
const ALPHA2_TO_COUNTRY_NAME = {
  CN: "china", IN: "india", DE: "germany", GB: "united kingdom", CA: "canada",
  MX: "mexico", BR: "brazil", FR: "france", JP: "japan", AU: "australia",
  SG: "singapore", ES: "spain", IT: "italy", NL: "netherlands", CH: "switzerland",
  IE: "ireland", PL: "poland", SE: "sweden", BE: "belgium", KR: "south korea",
  TW: "taiwan", HK: "hong kong", PH: "philippines", VN: "vietnam", TH: "thailand",
  MY: "malaysia", ID: "indonesia", ZA: "south africa", IL: "israel", TR: "turkey",
  AR: "argentina", CO: "colombia", CL: "chile", PT: "portugal", AT: "austria",
  DK: "denmark", NO: "norway", FI: "finland", CZ: "czech republic", RO: "romania",
  HU: "hungary", GR: "greece", NZ: "new zealand", AE: "united arab emirates",
  SA: "saudi arabia", EG: "egypt", RU: "russia",
};

function normalizeWorkdayJob(raw, employer) {
  const { tenant, wdNumber, site } = parseWorkdayIdentifier(employer.ats_identifier);
  const baseUrl = `https://${tenant}.${wdNumber}.myworkdayjobs.com/${site}`;
  const jobUrl = `${baseUrl}${raw.externalPath}`;
  const info = raw.detail?.jobPostingInfo || {};
  const description = info.jobDescription || "";
  const childBrand = extractChildBrand(tenant, description);

  // Reported directly: multi-location postings showed a generic "2
  // Locations" (or "US Territory Field based") placeholder instead of
  // real place names, and two Australian postings weren't being
  // caught by the foreign-country filter at all - because location_raw
  // was pulling from the LIST view's summary text (locationsText),
  // which is exactly that generic placeholder for any multi-location
  // req, never the real city/state/country. Workday's own detail
  // payload (already being fetched for every relevant job, one request
  // per posting) has the real data the list view only hints at:
  // jobPostingInfo.location is a clean "City, State, Country" string,
  // and additionalLocations is an array of the same for every other
  // site a multi-location req is open at. Joining these gives a real,
  // complete location string - which also means the existing
  // country-name text check downstream can actually catch a foreign
  // posting like "Sydney, New South Wales, Australia", since the word
  // "Australia" is now genuinely present in the text instead of never
  // having been fetched at all.
  const additionalLocs = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
  const realLocations = [info.location, ...additionalLocs].filter(Boolean);
  let location_raw = realLocations.length > 0 ? realLocations.join(" | ") : (raw.locationsText || "");
  if (realLocations.length === 1) {
    location_raw = validatedVirtualCity(raw.title, realLocations[0]) || location_raw;
  }
  // Belt-and-suspenders: Workday's detail payload also carries an
  // explicit ISO country code, a more reliable signal than text-
  // matching alone since it can't be missed by phrasing. Translated to
  // a full country name (not just appending the bare 2-letter code,
  // which the downstream text-based detector wouldn't recognize) and
  // added to location_raw only if that country isn't already
  // genuinely mentioned there, so foreign-country detection can never
  // miss a posting regardless of how its location text was phrased.
  const { normalizeCountryCode } = require('../locationTextRules');
  const country = info.jobRequisitionLocation?.country;
  const countryCode = normalizeCountryCode(country?.alpha2Code || country?.descriptor || country?.name || (typeof country === 'string' ? country : null));
  const countryName = countryCode ? ALPHA2_TO_COUNTRY_NAME[countryCode] : null;
  if (countryName && !new RegExp(`\\b${countryName}\\b`, "i").test(location_raw)) {
    location_raw = location_raw ? `${location_raw}, ${countryName}` : countryName;
  }

  return {
    source_job_id: info.jobReqId || raw.bulletFields?.[0] || raw.externalPath,
    employer_id: employer.id,
    source_type: "workday",
    source_url: jobUrl,
    application_url: jobUrl,
    title_original: raw.title,
    company_name: childBrand || employer.company_name,
    description_html: info.jobDescription || null,
    description_text: stripHtml(description),
    location_raw,
    location_evidence: { version: 1, source_country_code: countryCode, source_location: location_raw },
    // Workday's list view only gives relative text ("Posted 3 Days Ago"),
    // not a real date — leaving this null rather than guessing.
    date_posted: null,
    status: "active",
    source_verified: true,
  };
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ")
    // Reported via audit: literal "&nbsp;" and encoded apostrophes were
    // showing up in public job descriptions - stripping tags alone
    // doesn't decode HTML entities, so they survived as raw text.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&hellip;/gi, "...")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { fetchWorkdayJobs, normalizeWorkdayJob, parseWorkdayIdentifier, validatedVirtualCity };
