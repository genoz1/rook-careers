# ROOK Careers — Production Readiness Audit

**Date:** 2026-10-08  
**Production:** https://rookcareers.com  
**Repository tip audited against:** `github/main` @ `f855ae1` (includes PR #73)  
**Mode:** Audit-only. No product code changes, no production data writes, no real charges.

**Method notes**
- Live HTTP/API probes from the audit environment (Cloudflare → DigitalOcean Express).
- Code-path review for Stripe entitlements, masking, scoring, email, ingestion.
- Stripe is on **live** publishable keys (`pk_live_…`), so end-to-end checkout/unlock could not be exercised with safe test cards. Those items are **UNVERIFIED**, not PASS.
- Mobile viewport walkthrough was started in parallel; treat mobile layout items as **UNVERIFIED** unless marked with live evidence below.
- PASS requires direct evidence from this audit. Prior merge history alone is never treated as PASS.

---

## Executive summary

ROOK’s current paid funnel (acquisition → three membership prices → checkout → dashboard) is structurally present and server-side job masking is real. Several customer-facing and reliability defects remain that should be fixed before treating the site as ready for unattended paying traffic.

Highest-risk themes:
1. **Public performance / SEO reliability** — unscoped `/api/jobs` and cold SEO/sitemap paths are multi-second (sometimes timing out).
2. **Masked-location usefulness** — large share of locked cards omit city/state.
3. **Acquisition score inflation** — location-only ranking still clusters near 99%.
4. **Paid entitlement path unproven on live** — cannot safely charge; Settings still contains Free Trial copy.
5. **Ingestion/ops visibility** — no production health surface; scheduled success is UNVERIFIED from outside.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **PASS** | Tested in this audit with supporting evidence |
| **FAIL** | Tested; defect confirmed |
| **UNVERIFIED** | Not safely testable here, or evidence incomplete |

---

## 1. Customer journey

| Step | Status | Evidence |
|------|--------|----------|
| Homepage loads | **PASS** | HTTP 200, ~0.14s TTFB, title/meta/canonical present |
| Homepage CTAs / nav links | **PASS** (minor) | 26/27 internal links OK; Cloudflare email-protection HEAD quirk only |
| Acquisition (`/rook-onboarding-v8.html` → `rook-acquisition.html`) | **PASS** | Serves acquisition UI; `/api/v8/bootstrap` + `/api/v8/session` return locked cards |
| Location change on acquisition | **PASS** (code+API) | POST `/api/v8/session` Miami → 48 locked jobs in ~1.0s |
| Industry preference UI | **UNVERIFIED** | Preference API exists (`PUT /api/v8/preference`); full UI path not browser-completed in this pass |
| Masked results usefulness | **FAIL** | See finding A2 / B1 |
| Pricing (3 plans, no free tier on live funnel pages) | **PASS** | Live pricing/checkout/acquisition show $5.99 / $9.99→$19.99 / $39.99; no free-trial copy on those pages |
| Account creation / email verify | **PASS** (surface) | Signup page: create account → verify code → payment; no free-trial marketing copy in visible text |
| Checkout initiation | **PASS** (surface) | Live checkout loads Stripe.js + plan picker; requires auth |
| Payment confirmation / unlock | **UNVERIFIED** | Live Stripe keys; no safe charge performed |
| Member dashboard access | **UNVERIFIED** (paid) / **PASS** (anonymous gate) | `/rook-dashboard-v8.html` loads; auth required for data; paid paint not tested |
| Job details / apply links (paid) | **UNVERIFIED** | Gated in code (`requireFullAccess`); not live-unlocked |
| Returning login | **PASS** (surface) | `/rook-login.html` and `/rook-login-v8.html` load |
| Subscription management | **UNVERIFIED** | Portal session endpoint exists; Settings still shows Free Trial strings |

### Findings — journey

#### A1 — Settings still presents “Free Trial” membership copy  
- **Severity:** HIGH  
- **Component:** `public/rook-settings.html` (live)  
- **Defect:** Subscription status UI still renders `Free Trial`, `Free Trial — Ends …, then $19.99/month`, `Free Trial — Canceled`.  
- **Evidence:** Production HTML contains those strings (3× “Free Trial”). Current acquisition is paid-only.  
- **Root cause:** Legacy trial UI not removed from member Settings.  
- **Customer impact:** Paying/returning members can believe they are on a free trial; support/trust risk; contradicts “no free membership.”  
- **Fix:** Rewrite status copy around active / pass expiry / canceled / past_due only.  
- **Complexity:** Low  

#### A2 — Locked acquisition cards omit location too often  
- **Severity:** HIGH  
- **Component:** Masked projection (`safeLocationLabel` / acquisition cards)  
- **Defect:** Spec requires actual city/state when known; many locked cards have `location_label: null`.  
- **Evidence:** Miami `/api/v8/session` → 15/48 null locations; anonymous `/api/jobs?limit=200&public=1` → 86/200 (43%) null.  
- **Root cause:** `safeLocationLabel` returns null unless city+state resolve via ZIP table or remote/state heuristics; many active jobs lack clean city/state.  
- **Customer impact:** Preview feels empty/generic; weakens conversion.  
- **Fix:** Backfill location fields; broaden safe fallbacks (state-only, validated `location_raw` patterns) without leaking employer territory quirks.  
- **Complexity:** Medium  

#### B1 — Acquisition match scores cluster at 99% without a résumé  
- **Severity:** HIGH  
- **Component:** V8 acquisition ranking / preference-only scoring  
- **Defect:** Soft-cap prevents 100%, but almost every card is 99%.  
- **Evidence:** Miami session: 42×99, 4×98, 2×97, **0×100** across 48 jobs.  
- **Customer impact:** “Strong match” loses meaning; looks fake.  
- **Fix:** Widen preference-only score spread (distance/industry/freshness differentiation) without new embedding spend.  
- **Complexity:** Medium  

#### B2 — Legacy `/medical-sales/free-trial` URL still redirects into funnel  
- **Severity:** MEDIUM  
- **Component:** `server.js` redirect  
- **Defect:** Path name promises a free trial; destination is paid acquisition.  
- **Evidence:** `302 → /rook-onboarding-v8.html`; page shows paid plans.  
- **Customer impact:** Ad/SEO mismatch; regulatory/advertising honesty risk if ads still use this URL.  
- **Fix:** Keep redirect for old ads but ensure ad copy/landing H1 never say free; consider intermediate interstitial.  
- **Complexity:** Low  

---

## 2. Masked dashboard and paid access

| Check | Status | Evidence |
|-------|--------|----------|
| Anonymous `/api/jobs` strips employer/title/apply/description | **PASS** | Keys limited to locked projection; no company/apply/title_original |
| Anonymous `/api/jobs/:id` masked | **PASS** | Same locked shape; `subscription_required: true` |
| Public SEO job pages masked | **PASS** | Generalized role titles; WebPage schema; no apply URLs; no brand leak in sampled pages |
| Acquisition `/api/v8/*` locked projection | **PASS** (masking) | No employer/URLs in bootstrap/session samples |
| Paying customer full reveal | **UNVERIFIED** | `reveal()` / `hasFullAccess` code paths exist; not live-tested |
| Client-only masking risk | **PASS** (primary routes) | Redaction/projection performed server-side before response |

### Findings — masking

#### A3 — Dead preview endpoints return useless placeholders  
- **Severity:** MEDIUM (HIGH if any client still depends on them)  
- **Component:** `GET /api/onboarding/job-preview`, `POST /api/onboarding/anonymous-preview`  
- **Defect:** Returns `title: "Personalized opportunity"`, `location_display: "Location hidden"`, scores 99.  
- **Evidence:** Live probes, 2026-10-08. Current acquisition uses `/api/v8/*` instead.  
- **Impact:** Any leftover client/email/tooling hitting these APIs shows worthless cards.  
- **Fix:** Retire or rewire to `project()` / public preview contract; add regression test.  
- **Complexity:** Low  

#### B3 — Employer directory intentionally public  
- **Severity:** LOW (policy)  
- **Component:** `/rook-companies.html`, `/api/public-companies`  
- **Defect vs strict reading of “must NOT see employer identity”:** directory lists real employer names (410 companies).  
- **Evidence:** API returns Abbott, AbbVie, etc.; page indexable (no noindex).  
- **Note:** This is employer *coverage* marketing, not per-job identity. Confirm product intent.  
- **Fix (if undesired):** noindex and/or require auth.  
- **Complexity:** Low  

---

## 3. Job inventory and relevance

| Check | Status | Evidence |
|-------|--------|----------|
| Active inventory size | **PASS** | `/api/public-job-count` → `5360` |
| Sales-oriented titles in anonymous sample | **PASS** (sample) | Top roles are sales/account/territory; no nurse/tech/receptionist hits in 200-card sample |
| Clinical non-sales exclusion | **UNVERIFIED** at inventory scale | “Clinical Sales Specialist” present (often sales); full description audit not done |
| Petco/Chewy retail block present in code | **PASS** (code) | `employerSourcePolicy` contains petco/chewy blocks |
| Petco absent from live inventory | **UNVERIFIED** | No admin query performed |
| Duplicates / closed jobs | **UNVERIFIED** | Sitemap has 4941 job URLs; closure freshness not measured |
| Industry classification coverage | **FAIL** (partial) | 27/200 public cards had empty industry labels |
| Official career-site spot checks | **UNVERIFIED** | Not performed this pass |

### Findings — inventory

#### B4 — Unclassified jobs still surface in public/locked feeds  
- **Severity:** MEDIUM  
- **Evidence:** 27/200 anonymous jobs with `(none)` industry labels.  
- **Impact:** Weaker filtering and SEO snippets.  
- **Fix:** Classification backfill + ingest gate.  
- **Complexity:** Medium  

---

## 4. Matching and scoring

| Check | Status | Evidence |
|-------|--------|----------|
| Live path uses `scoreLiveJob` + `smoothLocalDistance` | **PASS** (code on main) | `jobs.js` imports `scoreLiveJob`; `liveScoring.js` sets options |
| Soft-cap 100% → 99 unless `excellent_match` | **PASS** (code + live acquisition) | `matching.js` lines ~1059–1063; Miami sample had 0×100 |
| Industry / territory / résumé ranking quality | **UNVERIFIED** | Needs paid/test profiles with résumés |
| Dashboard uses intended config after #72 | **PASS** (code deployed) | Main includes scoring corrections; live soft-cap behavior matches |

### Findings — scoring

See **B1** (99% cluster). Remaining résumé/geo edge cases need fixture-driven live checks with test accounts.

---

## 5. Performance

Measured from audit host (3-sample averages unless noted):

| Surface | Result | Status |
|---------|--------|--------|
| Homepage HTML | ~0.14s | **PASS** |
| Acquisition HTML | ~0.07s | **PASS** |
| Pricing / checkout HTML | ~0.07–0.09s | **PASS** |
| Dashboard HTML shell | ~0.07s | **PASS** |
| `/api/public-job-count` | ~0.3–2.0s | **PASS**/watch |
| `/api/jobs?limit=20` (no geo) | **~5.6–10.6s** | **FAIL** |
| `/api/jobs` with `near_lat/lng` | **~0.82s** | **PASS** relative |
| `/api/v8/session` (Miami) | **~1.0s** | **PASS** |
| `/api/v8/bootstrap` | ~0.7–0.8s | **PASS** |
| `/jobs` directory | ~0.5–0.8s | **PASS** |
| `/jobs/category/medical-sales-jobs` cold | **~22–25s** then ~0.06s cached | **FAIL** |
| `/sitemap.xml` | **~4–32s**; earlier 504/timeout at 45s | **FAIL** |
| LCP / INP / CLS (RUM) | **UNVERIFIED** | No browser lab metrics captured yet |
| Member `/jobs?limit=300` authenticated | **UNVERIFIED** | |

### Findings — performance

#### A4 — Unscoped `/api/jobs` is too slow (and can 500 under load)  
- **Severity:** CRITICAL  
- **Evidence:** 6–10s typical; earlier probe returned HTTP 500 after ~18s. Geo-scoped request ~0.8s.  
- **Root cause (likely):** Full-inventory path / ranking without geo pool (`geoJobPool`) when lat/lng absent.  
- **Impact:** Anonymous browse, bots hitting `/api/jobs` (allowed in robots.txt), and any client omitting coords feel broken.  
- **Fix:** Always require or default geo; hard timeout; ensure public path uses capped pool; consider removing `Allow: /api/jobs` from robots.  
- **Complexity:** Medium  

#### A5 — Main sitemap generation is unreliable for crawlers  
- **Severity:** CRITICAL  
- **Evidence:** 504 / 45s timeout in one probe; 31.7s success in another; later ~4s (cache/warm). ~4941 job URLs, ~439KB.  
- **Impact:** Google may fail sitemap fetches; ranking for medical/device/vet sales queries suffers.  
- **Fix:** Precompute sitemap artifact; paginated sitemap index; cache at CDN with stale-while-revalidate; fail fast with 503+Retry-After (already preferred in tests) but keep p95 < 2s.  
- **Complexity:** Medium  

#### B5 — SEO collection pages have severe cold-start latency  
- **Severity:** HIGH  
- **Evidence:** medical-sales category 22–25s first hit.  
- **Fix:** Cache rendered HTML; incremental generation.  
- **Complexity:** Medium  

---

## 6. Mobile experience

| Check | Status |
|-------|--------|
| Viewport meta present on key pages | **PASS** (HTML) |
| iPhone Safari / Android Chrome layouts | **UNVERIFIED** (browser pass incomplete at report time) |
| iOS input zoom / checkout usability | **UNVERIFIED** |

Checkout CSS already stacks plans to 1 column under 620px (code review). Still needs device verification.

---

## 7. Subscriptions and payments

| Check | Status | Evidence |
|-------|--------|----------|
| Plan amounts in code | **PASS** | `two_day` 599, `monthly` 999 intro via $10 coupon off 1999, `three_month` 3999 |
| Live UI prices | **PASS** | Match $5.99 / $9.99→$19.99 / $39.99 |
| `purchase-membership` grants access | **PASS** (code) | Upserts `subscription_status` + `subscription_cancel_at` for passes |
| `hasFullAccess` honors expiry timestamps | **PASS** (code) | Cancel-at and trial-end checks |
| Webhook signature verification | **PASS** (code) | `constructEvent` + `express.raw` before JSON parser |
| Live webhook delivery / unlock | **UNVERIFIED** | |
| Payment failure / cancel / portal | **UNVERIFIED** | Endpoints exist |
| Safe test charge | **FAIL to execute** | Production `pk_live` — audit correctly refused real charges |

### Findings — payments

#### A6 — No safe production payment rehearsal path  
- **Severity:** HIGH (process/readiness)  
- **Defect:** Production checkout is live-mode only from the public site.  
- **Impact:** Cannot prove unlock/revoke before customers pay.  
- **Fix:** Staging with `pk_test` / Stripe test clock, or a controlled test coupon path; run one full purchase+expiry rehearsal there.  
- **Complexity:** Medium (ops)  

#### B6 — Monthly intro depends on Stripe coupon env  
- **Severity:** MEDIUM  
- **Evidence:** Missing `STRIPE_V9_FIRST_MONTH_COUPON_ID` → HTTP 503 “Monthly membership is temporarily unavailable.”  
- **Impact:** Monthly plan can hard-fail while passes still work.  
- **Fix:** Synthetic monitor on coupon+price validation; alert on 503.  
- **Complexity:** Low  

---

## 8. Email notifications

| Check | Status | Evidence |
|-------|--------|----------|
| “Untitled role” recurrence guard | **PASS** (code) | `validDisplayText` rejects untitled/null/placeholder; invalid jobs dropped |
| Non-subscriber emails use generalized roles | **PASS** (code) | `prepareDigestJobs` → `generalizedRole` / `publicPreview` |
| Live send content / frequency / duplicates | **UNVERIFIED** | No Resend inbox probe |

---

## 9. SEO and indexing

| Check | Status | Evidence |
|-------|--------|----------|
| Homepage title/description/canonical | **PASS** | Medical/pharma/device/vet sales messaging |
| `robots.txt` | **PASS** with caveat | Allows `/`, disallows `/api/` but **allows `/api/jobs`** |
| Main sitemap | **FAIL** | Reliability — see A5 |
| Resources/news sitemaps | **PASS** | 200 in <1s |
| Public job pages no employer leakage | **PASS** | Sampled 5 IDs |
| Structured data leakage | **PASS** (sample) | WebPage/CollectionPage, not JobPosting+hiringOrganization |
| `/jobs/florida` | **FAIL** | HTTP 404 |
| Category page card headings | **FAIL** (quality) | H2 uses industry labels, role relegated to subtitle |

### Findings — SEO

#### B7 — `robots.txt` allows crawling `/api/jobs`  
- **Severity:** MEDIUM  
- **Evidence:** `Allow: /api/jobs` while API is slow and JSON.  
- **Impact:** Crawler load on the worst endpoint; little SEO value.  
- **Fix:** Remove allow; keep HTML `/jobs` routes.  
- **Complexity:** Low  

#### B8 — Category listing uses industry as the heading  
- **Severity:** MEDIUM  
- **Evidence:** `publicPages.js` collection template H2 = industry labels.  
- **Impact:** Weaker relevance for “medical device sales jobs” queries; poor snippet quality.  
- **Fix:** H2 = `role_type`; industry as meta line.  
- **Complexity:** Low  

#### C1 — Missing `/jobs/florida` (and similar state shortcuts)  
- **Severity:** LOW  
- **Evidence:** 404. Category+state routes exist as `/jobs/category/:slug/:state`.  
- **Fix:** Redirect popular shortcuts or leave 404 if unused.  
- **Complexity:** Low  

---

## 10. Security and reliability

| Check | Status | Evidence |
|-------|--------|----------|
| Stripe webhook raw body + signature | **PASS** (code) | |
| Job detail / apply entitlement checks | **PASS** (code) | `requireFullAccess` on apply/save/search |
| Admin API without auth | **PASS** | `/api/admin/employers` → 401 |
| Admin HTML public exposure | **FAIL** (surface) | Pages return 200; `noindex` only |
| Secrets in client config | **PASS** (expected) | Anon + publishable only (no service role observed) |
| Rate limit on v8 onboarding | **PASS** (code) | 35/min/IP |
| Global API rate limit | **UNVERIFIED** / weak | Not universal |
| Ingestion silent failure detection | **FAIL** (observability) | No public/admin health route found live |
| Error reporting (Sentry etc.) | **UNVERIFIED** | |

### Findings — security/reliability

#### B9 — Admin UIs are world-reachable static pages  
- **Severity:** MEDIUM  
- **Evidence:** `/rook-admin-employers.html`, `/rook-admin-recruiters.html`, `/rook-admanager.html` → 200 + `noindex`. APIs still 401.  
- **Impact:** Attack surface / probing; admanager calls `/api/admin`.  
- **Fix:** Basic auth at edge, IP allowlist, or remove from public static hosting.  
- **Complexity:** Low–Medium  

#### A7 — No live ingestion/health signal  
- **Severity:** HIGH  
- **Evidence:** `/api/health`, `/api/ingestion-health` → 404. Watchdog exists in repo but not exposed/verifiable.  
- **Impact:** Queue starvation / stalled discovery can recur silently — the exact class of regression this audit was meant to prevent.  
- **Fix:** Authenticated health endpoint + external uptime check on last successful ingest timestamp / backlog depth.  
- **Complexity:** Medium  

---

## 11. Ingestion and discovery regression check

| Change | In repo on main | Live behavior |
|--------|-----------------|---------------|
| Petco/Chewy source policy | **PASS** | **UNVERIFIED** inventory effect |
| Six-category scheduled discovery (`query-limit 6`, `ingest-enrolled`) | **PASS** | **UNVERIFIED** cron |
| Never-checked scheduling fairness | **PASS** (code) | **UNVERIFIED** |
| Ingestion watchdog module | **PASS** (file present) | **UNVERIFIED** running |
| Geo job pool + dashboard perf (#70) | **PASS** (code) | Live geo `/api/jobs` faster — supports deploy |
| Scoring corrections (#72) | **PASS** (code) | Soft-cap observed live |
| Location loading indicator (#73) | **PASS** | Live dashboard HTML contains `locationHint` / banner copy |

**Verdict:** Recent fixes are **present in production code**. Operational proof that nightly ingest/discovery are healthy is **UNVERIFIED** without DO logs or a health metric.

---

## 12. Prioritized findings

### A. Must fix before accepting paying customers

| ID | Severity | Item |
|----|----------|------|
| A4 | CRITICAL | Fix unscoped `/api/jobs` latency / 500s |
| A5 | CRITICAL | Make `/sitemap.xml` fast and reliable |
| A1 | HIGH | Remove Free Trial copy from Settings |
| A2 | HIGH | Restore city/state on locked cards when known |
| A6 | HIGH | Prove payment→unlock→expiry on staging/test Stripe |
| A7 | HIGH | Expose/monitor ingestion health (backlog, last success) |
| B1 | HIGH | Reduce 99% match clustering on acquisition |
| B5 | HIGH | Cache/pre-render SEO category pages |

### B. Important improvements

| ID | Severity | Item |
|----|----------|------|
| A3 | MEDIUM | Retire placeholder onboarding preview APIs |
| B2 | MEDIUM | Free-trial URL honesty / ad alignment |
| B4 | MEDIUM | Backfill missing industry labels |
| B6 | MEDIUM | Monitor monthly coupon/price config |
| B7 | MEDIUM | Disallow `/api/jobs` in robots.txt |
| B8 | MEDIUM | Category H2 = role, not industry |
| B9 | MEDIUM | Lock down admin HTML |

### C. Optional enhancements

| ID | Severity | Item |
|----|----------|------|
| B3 | LOW | Policy call on public employer directory |
| C1 | LOW | `/jobs/florida` redirect |
| — | LOW | Homepage static brand logos are fine for marketing; keep distinct from per-job masking |

---

## 13. What passed verification

- Homepage metadata, canonical, primary nav targets  
- Live funnel pricing pages (3 paid plans; no free-tier copy on acquisition/pricing/checkout)  
- Server-side masking for anonymous `/api/jobs`, `/api/jobs/:id`, `/api/v8` preview, public `/jobs/:id` SEO pages  
- Soft 100% score reserve behavior on live acquisition ranking  
- Stripe plan amounts and webhook signature wiring (code)  
- Email “Untitled” / placeholder rejection (code)  
- Resources + news sitemaps  
- Admin JSON API auth gate (401 without token)  
- Presence on main/production of recent ingestion, scoring, and dashboard-loading fixes  

---

## 14. Recommended repair sequence

Efficient order (max risk reduction first; combinable packs noted):

1. **Perf pack (combine):** A4 + A5 + B5 + B7  
   - Cap/default-geo for public jobs API; precompute sitemap index; cache category HTML; stop robots from hitting `/api/jobs`.  
2. **Trust pack (combine):** A1 + A2 + B1  
   - Settings copy; location labels; score spread on locked ranking.  
3. **Proof pack:** A6 + A7  
   - Staging payment rehearsal; ingestion health metric + alert.  
4. **Cleanup pack (combine):** A3 + B2 + B8 + B9 + B4 + B6  
   - Dead APIs, SEO headings, admin exposure, classification backfill, coupon monitor.

Do **not** start a rewrite. Do **not** change prices or business rules except removing obsolete free-trial presentation.

---

## 15. Explicit UNVERIFIED backlog (next audit slice)

1. Full browser journey on iPhone Safari + Android Chrome (layout, zoom, checkout).  
2. Stripe test-mode purchase for each of the three plans → dashboard unlock → apply URL → expiry/revoke.  
3. Member dashboard with résumé vs without (score distribution, territory).  
4. DigitalOcean cron logs: discovery, ingest, watchdog, digest sends.  
5. Spot-check 25 random active jobs against employer career sites.  
6. Field LCP/INP/CLS via CrUX or lab trace on homepage, acquisition, dashboard.

---

*End of audit report.*
