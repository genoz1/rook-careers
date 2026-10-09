const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseJobCards,
  classifyPresence,
  searchKeywords,
  shouldShowNotOnLinkedInBadge,
  projectPresenceFields,
  mergePresenceIntoEvidence,
} = require("./linkedinJobPresence");

test("search keywords prefer company + short title tokens", () => {
  const kw = searchKeywords({
    company_name: "Stryker Inc.",
    title_original: "Account Executive - Morgantown, WV",
  });
  assert.match(kw, /stryker/i);
  assert.match(kw, /account/i);
  assert.match(kw, /executive/i);
  assert.doesNotMatch(kw, /morgantown/i);
});

test("parseJobCards reads guest LinkedIn HTML cards", () => {
  const html = `
    <div class="base-card relative base-card--link base-search-card job-search-card">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/foo-123?ref=1"></a>
      <h3 class="base-search-card__title">Territory Manager - Sacramento</h3>
      <h4 class="base-search-card__subtitle">Stryker</h4>
      <span class="job-search-card__location">Sacramento, CA</span>
    </div>`;
  const cards = parseJobCards(html);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].company, "Stryker");
  assert.match(cards[0].href, /\/jobs\/view\/foo-123$/);
});

test("strong company+title match is on_linkedin (badge off)", () => {
  const job = {
    company_name: "U.S. Bank Healthcare Business Banking",
    title_original: "Business Banking Sales Manager",
    state: "CA",
    location_raw: "CA",
  };
  const cards = [
    { title: "Business Banking Sales Manager", company: "U.S. Bank", loc: "Torrance, CA", href: "https://www.linkedin.com/jobs/view/1" },
  ];
  const result = classifyPresence(job, cards);
  assert.equal(result.status, "on_linkedin");
  assert.equal(result.tier, "on_linkedin_same_area");
  assert.equal(shouldShowNotOnLinkedInBadge(result), false);
});

test("company-only / wrong brand family is not_on_linkedin (badge on)", () => {
  const job = {
    company_name: "Tandem Health",
    title_original: "Senior Account Executive - Hospitals",
    location_raw: "Paris",
  };
  const cards = [
    { title: "Sr Trade Account Manager", company: "Tandem Diabetes Care", loc: "United States", href: "https://www.linkedin.com/jobs/view/2" },
  ];
  const result = classifyPresence(job, cards);
  assert.equal(result.status, "not_on_linkedin");
  assert.equal(shouldShowNotOnLinkedInBadge(result), true);
});

test("ambiguous weak_title stays possible but still gets the badge", () => {
  const job = {
    company_name: "Align Technology",
    title_original: "Territory Manager - Brea, CA",
    state: "CA",
  };
  const cards = [
    { title: "Territory Sales Manager West", company: "Completely Different Inc", loc: "Brea, CA", href: "https://www.linkedin.com/jobs/view/3" },
  ];
  const result = classifyPresence(job, cards);
  assert.equal(result.why, "weak_title");
  assert.equal(result.status, "possible");
  // Only verified on-LinkedIn jobs skip the badge.
  assert.equal(shouldShowNotOnLinkedInBadge(result), true);
});

test("verified on_linkedin is the only status that skips the badge", () => {
  assert.equal(shouldShowNotOnLinkedInBadge("on_linkedin"), false);
  assert.equal(shouldShowNotOnLinkedInBadge("not_on_linkedin"), true);
  assert.equal(shouldShowNotOnLinkedInBadge("possible"), true);
  assert.equal(shouldShowNotOnLinkedInBadge("error"), false);
  assert.equal(shouldShowNotOnLinkedInBadge(null), false);
});

test("empty LinkedIn results are not_on_linkedin", () => {
  const result = classifyPresence(
    { company_name: "Obscure Device Co", title_original: "Territory Manager" },
    []
  );
  assert.equal(result.status, "not_on_linkedin");
  assert.equal(result.why, "no_results");
});

test("projectPresenceFields and evidence merge round-trip", () => {
  const presence = {
    status: "not_on_linkedin",
    tier: "not_on_linkedin",
    score: 0.2,
    why: "company_only",
    checked_at: "2026-10-09T00:00:00.000Z",
    search_url: "https://www.linkedin.com/jobs/search/",
    match: null,
    match_url: null,
    cards_seen: 10,
  };
  const evidence = mergePresenceIntoEvidence({ status: "validated", version: 4 }, presence);
  assert.equal(evidence.status, "validated");
  assert.equal(evidence.linkedin_presence.status, "not_on_linkedin");
  const projected = projectPresenceFields({ location_evidence: evidence });
  assert.equal(projected.linkedin_not_on_linkedin, true);
  assert.equal(projected.linkedin_presence_status, "not_on_linkedin");
});

test("dashboard and search mark up Not on LinkedIn badge without recoloring cards", () => {
  const dash = fs.readFileSync(path.join(__dirname, "../public/rook-dashboard-v8.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../public/rook-v8-member.css"), "utf8");
  const search = fs.readFileSync(path.join(__dirname, "../public/rook-search.html"), "utf8");
  assert.match(dash, /not-on-linkedin-badge/);
  assert.match(dash, /not-on-linkedin-badge__logo/);
  assert.match(dash, /linkedin_not_on_linkedin/);
  assert.match(dash, /Not on LinkedIn/);
  assert.match(dash, /v8-title-row/);
  assert.match(css, /\.not-on-linkedin-badge/);
  assert.match(css, /#0A66C2/);
  assert.match(css, /never hangs off/);
  assert.match(search, /not-on-linkedin-badge__logo/);
  // Card yellow "Just Posted" tint must stay independent of the LinkedIn badge
  assert.match(dash, /Card background stays on the existing Just Posted/);
});

test("ingest spawns presence checker after inserts", () => {
  const src = fs.readFileSync(path.join(__dirname, "ingest.js"), "utf8");
  assert.match(src, /checkLinkedInPresence\.js/);
  assert.match(src, /LINKEDIN_PRESENCE_AFTER_INGEST/);
});
