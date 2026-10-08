# ROOK Careers — Production Readiness Repairs Report

**Date:** 2026-10-08  
**Branch:** `cursor/production-readiness-repairs-d8ad`  
**PRs:** [#74](https://github.com/genoz1/rook-careers/pull/74) (merged), [#75](https://github.com/genoz1/rook-careers/pull/75) (merged hotfix)  
**Production:** https://rookcareers.com  

## Defects fixed and root causes

| ID | Defect | Root cause | Fix |
|----|--------|------------|-----|
| A4 | Unscoped `/api/jobs` 7–15s | Full `readJobPool` inventory on ordinary requests | Cap pool with `maxAccepted` / `poolCap` |
| A5 | `/sitemap.xml` 26–38s cold | Sequential full job URL scan + SEO inventory coupling | Static category URLs, parallel slim pages, in-memory cache + SWR, boot warm |
| B5 | Category pages 22–25s / 504 | Full inventory with `description_text` → PostgREST statement timeouts under parallel load; cache never warmed | Slim select (no descriptions), parallel stride-aware fetch, SWR, boot warm, bounded wait + Retry-After |
| B7 | `robots.txt` allowed `/api/jobs` | Explicit Allow overrode Disallow | Remove Allow; keep Disallow `/api/` |
| A1 | “Free Trial” in settings/auth | Stale copy | Membership-only labels for paid plans |
| A2 | Blank/weak masked locations | ZIP-miss dropped city/state | `normalizeCityStateInputs` + territory/remote labels |
| B1 | Near-identical 99% clusters | Weak no-resume differentiation | Freshness/distance/industry spread in preference scoring |
| B10 | Scoring drift across surfaces | Bare `scoreJob` on some paths | Unify on `scoreLiveJob` |
| A6 | Payment→entitlement proof | Needed fixtures | Stripe webhook fixtures for all three plans (test-mode) |
| A7 | Ingestion ops blind spot | No health summary | `GET /api/admin/ingestion-health` + `summarizeIngestionHealth` |

**Shared bottleneck:** expensive full-inventory IO on ordinary HTTP. Avoided via caps, slim selects, caching/SWR, and boot warm.

## Before / after performance (production)

| Endpoint | Before | After (post #75 warm) | Status |
|----------|--------|------------------------|--------|
| `/api/jobs?limit=20` | 7.4–14.8s, 200 | **1.2–1.4s**, 200 | **PASS** |
| Geo `/api/jobs` | ~0.9–1.0s | ~1.0–2.3s | **PASS** (unchanged order) |
| `/sitemap.xml` | 26–38s cold | **0.05–0.07s** warm | **PASS** |
| `/jobs/category/medical-sales-jobs` | 22–25s cold / 504 during broken rebuild | **0.05s** warm; brief 503/504 only while inventory warms after deploy | **PASS** (warm); cold window noted below |
| `/robots.txt` | Allowed `/api/jobs` | Disallow `/api/` only | **PASS** |

Local after-repair (warm): unscoped jobs 0.7–2.0s; sitemap ~0s; category ~0.2s. Evidence: `docs/production-readiness-repairs-before.json`, `docs/production-readiness-repairs-after-local.json`, `docs/production-readiness-repairs-after-prod.json`.

## Location completeness

- **Before:** ZIP lookup misses often cleared city/state → empty/generic masked locations.  
- **After:** Known city/state restored; territory → `Territory – FL, GA`; remote → `Remote – TX`.  
- Live sample (local geo `/api/jobs`): **20/20** cards with `location_label` (e.g. Miami, FL; Territory – OK on browse).  
- **Verdict: PASS** (does not invent employer identity).

## Match-score distribution

Fixture spread (no-resume, FL Medical Device prefs): scores **99 / 90 / 51** (WA pharma ineligible) — not a 99% cluster.  
`scoreLiveJob` wired on listings, detail, onboarding, precompute.  
**B1 PASS · B10 PASS**

## Stripe (A6)

| Check | Result |
|-------|--------|
| Webhook fixtures unlock 48h / monthly / 90-day | **PASS** (automated) |
| Expiration / cancel fields applied | **PASS** (fixtures) |
| Live checkout → webhook → dashboard unlock | **UNVERIFIED** (pk_live only in env; no real charges) |

## Ingestion health (A7)

Live `summarizeIngestionHealth` against production DB (2026-10-08):

- `ok: true`, `stale_ingestion: false`
- Last run `budget_exhausted` with `failed_sources: 3`
- Employers: 410 active, 0 never-checked, 19 held
- Watchdog: no problem

HTTP monitor route requires admin/token — token not configured in this environment → route HTTP **UNVERIFIED**; summarizer + DB signal **PASS**.

## Regression tests

| Suite | Result |
|-------|--------|
| `test-production-readiness-repairs` | **PASS** 11/11 |
| `test-pretrial-security` + public indexing | **PASS** |
| `test-scoring-matching-corrections` | **PASS** 11/11 |
| `test-masked-presentation` | **PASS** |
| `test-current-funnel` | **PASS** 9/9 |
| `testSeoCollections` | **PASS** 7/7 |

## Browser / customer journey

| Check | Result |
|-------|--------|
| robots.txt production | **PASS** (screenshot) |
| Category SEO page loads with counts | **PASS** (3591 jobs) |
| Browse locations (Territory – OK) | **PASS** |
| Settings Free Trial absent (source + membership labels) | **PASS** (login gate when anonymous) |
| Mobile browse usable | **PASS** (390px screenshot) |
| Full paid unlock journey | **UNVERIFIED** |

## Finding scorecard

| Finding | Verdict |
|---------|---------|
| A1 Free Trial copy | **PASS** |
| A2 Masked locations | **PASS** |
| A4 `/api/jobs` perf | **PASS** |
| A5 sitemap perf | **PASS** |
| A6 Stripe payment→unlock | **UNVERIFIED** (fixtures **PASS**) |
| A7 Ingestion health | **PASS** (HTTP token path **UNVERIFIED**) |
| B1 Score differentiation | **PASS** |
| B5 SEO category perf | **PASS** (warm); brief post-deploy warm window remains |
| B7 robots.txt | **PASS** |
| B10 Scoring unify | **PASS** |

## Commits and deployment

- `3d61afa` — initial repairs  
- `916237f` — parallel fetch + SWR warm  
- `6c77ffb` — slim inventory timeout hotfix  
- Merged to `main` via PR #74 and #75  
- DigitalOcean App Platform auto-deploy observed (robots + category 200)

## Remaining unresolved

1. **Live Stripe end-to-end unlock** still needs test-mode checkout with webhook delivery (do not use live cards).  
2. **Category cold window** after each deploy (~15–30s) until SEO inventory warm completes; may return 503/Retry-After or platform 504 if hit too early.  
3. **Ingestion `last_successful_run`** null while latest status is `budget_exhausted` — health `ok` but ops should treat budget exhaustion as actionable.  
4. **INGESTION_HEALTH_TOKEN** not confirmed in production env for external monitors.
