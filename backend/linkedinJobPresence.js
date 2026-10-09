// LinkedIn job-board presence — guest search + high-confidence match.
// $0 path: public LinkedIn /jobs/search HTML (no API key, no login).
// Badge only when status === 'not_on_linkedin' (high confidence).

const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TITLE_STOP = new Set([
  "a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with",
  "remote", "hybrid", "field", "based", "usa", "us", "united", "states",
  "america", "region", "regional", "area", "territory", "nationwide",
  "m", "f", "w", "d", "mw", "mwd",
]);

const STATE_NAME_TO_CODE = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9&\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length > 1 && !TITLE_STOP.has(t) && !/^\d+$/.test(t));
}

function stripCompanySuffixes(name) {
  return normalize(name)
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|plc|lp|llp|group|holdings?)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTitleTokens(title) {
  // Drop trailing geo / parenthetical noise common in ATS titles.
  let cleaned = String(title || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s[-–—|]\s.*$/, " ");
  const tokens = tokenize(cleaned).filter((t) => t.length > 2 || ["ae", "isr", "tm"].includes(t));
  return tokens.slice(0, 8);
}

function searchKeywords(job) {
  const company = stripCompanySuffixes(job.company_name || job.company || "");
  const titleBits = significantTitleTokens(job.title_original || job.title || "").slice(0, 5);
  return [company, ...titleBits].filter(Boolean).join(" ").trim();
}

function buildSearchUrl(job) {
  const keywords = searchKeywords(job);
  const params = new URLSearchParams({
    keywords,
    location: "United States",
    f_TPR: "",
  });
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function extractStateCodes(text) {
  const n = normalize(text);
  const found = new Set();
  for (const [name, code] of Object.entries(STATE_NAME_TO_CODE)) {
    if (n.includes(name)) found.add(code);
  }
  for (const m of String(text || "").match(/\b[A-Z]{2}\b/g) || []) {
    if (Object.values(STATE_NAME_TO_CODE).includes(m)) found.add(m);
  }
  // bare lowercase state codes from normalized text (e.g. "columbus ohio")
  for (const code of Object.values(STATE_NAME_TO_CODE)) {
    if (new RegExp(`\\b${code.toLowerCase()}\\b`).test(n)) found.add(code);
  }
  return [...found];
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function companyMatchScore(jobCompany, cardCompany) {
  const a = stripCompanySuffixes(jobCompany);
  const b = stripCompanySuffixes(cardCompany);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const ta = tokenize(a);
  const tb = tokenize(b);
  const overlap = jaccard(ta, tb);
  // Brand-family near-miss (Tandem Health vs Tandem Diabetes Care): shared
  // first token only is not enough for a company match.
  if (overlap >= 0.5) return overlap;
  if (ta[0] && ta[0] === tb[0] && ta.length > 1 && tb.length > 1) return 0.25;
  return overlap;
}

function titleMatchScore(jobTitle, cardTitle) {
  const a = significantTitleTokens(jobTitle);
  const b = significantTitleTokens(cardTitle);
  if (!a.length || !b.length) return 0;
  const jac = jaccard(a, b);
  const covered = a.filter((t) => b.includes(t)).length / a.length;
  return Math.max(jac, covered * 0.85);
}

function locationTier(job, cardLoc) {
  const jobStates = new Set([
    ...(job.state ? [String(job.state).toUpperCase()] : []),
    ...extractStateCodes(job.location_raw || job.loc || ""),
  ]);
  const cardStates = new Set(extractStateCodes(cardLoc || ""));
  if (!jobStates.size || !cardStates.size) return "none";
  for (const s of jobStates) if (cardStates.has(s)) return "state";
  return "none";
}

function scoreCard(job, card) {
  const company = companyMatchScore(job.company_name || job.company, card.company);
  const title = titleMatchScore(job.title_original || job.title, card.title);
  const loc = locationTier(job, card.loc);
  let score = 0;
  let why = "weak";
  if (company >= 0.85 && title >= 0.55) {
    score = loc === "state" ? 6 : 5;
    why = "strong";
  } else if (company >= 0.85 && title >= 0.35) {
    score = 3;
    why = "partial_title";
  } else if (company >= 0.85 && title < 0.35) {
    score = 0.2;
    why = "company_only";
  } else if (company >= 0.5 && title >= 0.55) {
    score = 2;
    why = "fuzzy_company";
  } else if (company > 0 && company < 0.5) {
    score = 0.1;
    why = "company_mismatch";
  } else {
    score = title;
    why = title >= 0.35 ? "weak_title" : "no_match";
  }
  return { score, why, company, title, loc_tier: loc, card };
}

function classifyPresence(job, cards) {
  if (!cards.length) {
    return {
      status: "not_on_linkedin",
      tier: "not_on_linkedin",
      score: 0,
      why: "no_results",
      match: null,
      match_url: null,
      cards_seen: 0,
    };
  }
  const ranked = cards.map((c) => scoreCard(job, c)).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const match = best.card
    ? { title: best.card.title, company: best.card.company, loc: best.card.loc }
    : null;
  const match_url = best.card?.href || null;

  if (best.why === "strong") {
    return {
      status: "on_linkedin",
      tier: best.loc_tier === "state" ? "on_linkedin_same_area" : "on_linkedin_other_geo",
      score: best.score,
      why: best.why,
      match,
      match_url,
      cards_seen: cards.length,
      loc_tier: best.loc_tier,
    };
  }
  if (best.why === "partial_title" || best.why === "fuzzy_company") {
    return {
      status: "on_linkedin",
      tier: "on_linkedin_title_company",
      score: best.score,
      why: best.why,
      match,
      match_url,
      cards_seen: cards.length,
      loc_tier: best.loc_tier,
    };
  }
  if (best.why === "weak_title" && best.company >= 0.85) {
    return {
      status: "possible",
      tier: "possible_different_role",
      score: best.score,
      why: best.why,
      match,
      match_url,
      cards_seen: cards.length,
      loc_tier: best.loc_tier,
    };
  }
  return {
    status: "not_on_linkedin",
    tier: "not_on_linkedin",
    score: best.score,
    why: best.why,
    match,
    match_url: null,
    cards_seen: cards.length,
    loc_tier: best.loc_tier,
  };
}

function parseJobCards(html) {
  const $ = cheerio.load(html || "");
  if (/authwall|challenge|captcha/i.test($("title").text() || "") && !$("div.base-card.job-search-card, div.base-search-card.job-search-card").length) {
    const err = new Error("linkedin_authwall");
    err.code = "linkedin_authwall";
    throw err;
  }
  const cards = [];
  const seen = new Set();
  $("div.base-card.job-search-card, div.base-search-card.job-search-card").each((_, el) => {
    const $el = $(el);
    const title = $el.find("h3.base-search-card__title, h3.base-card__title").first().text().replace(/\s+/g, " ").trim();
    const company = $el.find("h4.base-search-card__subtitle, h4.base-card__subtitle").first().text().replace(/\s+/g, " ").trim();
    const loc = $el.find("span.job-search-card__location").first().text().replace(/\s+/g, " ").trim();
    const hrefRaw =
      $el.find("a.base-card__full-link").attr("href") ||
      $el.find("a.base-search-card__title-link").attr("href") ||
      $el.find("a[href*='/jobs/view/']").first().attr("href") ||
      "";
    const href = String(hrefRaw).split("?")[0];
    if (!title && !company) return;
    const key = `${title}|${company}|${loc}`;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({ title, company, loc, href });
  });
  return cards;
}

async function fetchSearchHtml(url, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const html = await res.text();
    if (!res.ok) {
      const err = new Error(`linkedin_http_${res.status}`);
      err.code = "linkedin_http";
      err.status = res.status;
      throw err;
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function checkJobPresence(job, options = {}) {
  const search_url = buildSearchUrl(job);
  const checked_at = new Date().toISOString();
  try {
    const html = await fetchSearchHtml(search_url, options);
    const cards = parseJobCards(html);
    const result = classifyPresence(job, cards);
    return { ...result, search_url, checked_at };
  } catch (error) {
    return {
      status: "error",
      tier: "error",
      score: 0,
      why: error.code || error.message || "error",
      match: null,
      match_url: null,
      cards_seen: 0,
      search_url,
      checked_at,
    };
  }
}

function presenceRecord(result) {
  return {
    status: result.status,
    tier: result.tier,
    score: result.score,
    why: result.why,
    checked_at: result.checked_at,
    search_url: result.search_url,
    match: result.match,
    match_url: result.match_url || null,
    cards_seen: result.cards_seen || 0,
    loc_tier: result.loc_tier || null,
  };
}

function shouldShowNotOnLinkedInBadge(jobOrPresence) {
  const status =
    typeof jobOrPresence === "string"
      ? jobOrPresence
      : jobOrPresence?.linkedin_presence_status ||
        jobOrPresence?.linkedin_presence?.status ||
        jobOrPresence?.location_evidence?.linkedin_presence?.status ||
        jobOrPresence?.status;
  return status === "not_on_linkedin";
}

function mergePresenceIntoEvidence(locationEvidence, presence) {
  const base = locationEvidence && typeof locationEvidence === "object" ? { ...locationEvidence } : {};
  base.linkedin_presence = presenceRecord(presence);
  return base;
}

function projectPresenceFields(job) {
  const presence = job?.linkedin_presence || job?.location_evidence?.linkedin_presence || null;
  if (!presence) {
    return {
      linkedin_presence_status: job?.linkedin_presence_status || null,
      linkedin_not_on_linkedin: job?.linkedin_not_on_linkedin === true,
    };
  }
  return {
    linkedin_presence_status: presence.status || null,
    linkedin_not_on_linkedin: presence.status === "not_on_linkedin",
  };
}

module.exports = {
  normalize,
  tokenize,
  stripCompanySuffixes,
  significantTitleTokens,
  searchKeywords,
  buildSearchUrl,
  parseJobCards,
  scoreCard,
  classifyPresence,
  checkJobPresence,
  presenceRecord,
  shouldShowNotOnLinkedInBadge,
  mergePresenceIntoEvidence,
  projectPresenceFields,
  fetchSearchHtml,
};
