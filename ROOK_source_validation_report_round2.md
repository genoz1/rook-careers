# ROOK Careers — Source Adapter Validation, Round 2
Sept 18, 2026. Built on `rook-careers-validated.zip` (Round 1's output), used as source of truth — nothing reverted or reconstructed from the older repo. Nothing deployed, pushed, or executed this round either.

## Pre-flight verification (done before any changes, as instructed)
1. SuccessFactors rewrite present — confirmed (`grep "REPLACED Sept 2026" backend/adapters/successfactors.js` → 1 match).
2. Workable multi-location fix present — confirmed (`grep "LOCATION FIX (Sept 2026)" backend/adapters/workable.js` → 1 match).
3. New tests/fixtures present — confirmed: `testSuccessFactors.js`, `testWorkable.js`, `testCustomHtmlNewCandidates.js`, `fixtures/successfactors/`, `fixtures/customHtml/tg-therapeutics*.html` all present.
4. **Actually ran** `node --test backend/testCustomHtml.js backend/testCustomHtmlNewCandidates.js backend/testSuccessFactors.js backend/testWorkable.js` → **34/34 pass**, verified fresh in this repo, not assumed from the prior report.

## 1. Code changes this round
- **`backend/adapters/pinpoint.js`** — reusable fix: now accepts either a bare Pinpoint subdomain (`exactech` → `exactech.pinpointhq.com`) or a full custom hostname used as-is (`jobs.aligntech.com`). Align Technology's careers site is confirmed live and "Powered by" Pinpoint but hosted on Align's own CNAME'd domain, which the old hardcoded `${subdomain}.pinpointhq.com` couldn't reach. This is a platform-wide variation (any CNAME'd Pinpoint tenant hits the same wall), not an Align-specific hack.
- **`backend/adapters/clinchtalent.js`** — refresh-safety fix (found while writing its test, same class of bug as last round's SuccessFactors fix): a blocked page, non-2xx response, or zero job links on page 1 used to just `break` silently, returning `[]` — which would make `ingest.js` close every existing job for that employer. Now: a page-1 non-ok response or fetch failure throws; zero job links on page 1 only counts as a genuine empty result if the page's own text explicitly says so, otherwise it throws. A later page (2+) failing still doesn't invalidate already-collected rows.
- No changes needed to: `workday.js`, `greenhouse.js`, `oraclehcm.js`, `adp.js`, `successfactors.js`, `applicantpro.js`, `phenom.js` — their existing identifier formats already fit what was found live (see table below). **Correction to Round 1's own finding**: Castle Biosciences' `www.applicantpro.com/openings/castlebiosciences/jobs` link 302-redirects straight to `castlebiosciences.applicantpro.com/jobs/` — the exact URL the existing adapter already fetches. There is no URL-shape mismatch after all; Round 1's classification of this as "adapter bug" was premature. `applicantpro.js` is left unchanged.

## 2. New fixtures and tests
| File | Covers |
|---|---|
| `backend/testPinpoint.js` | Bare-subdomain (no regression) + custom-domain host resolution, non-ok handling |
| `backend/testClinchTalent.js` | Bio-Rad-shaped pagination/dedup/relevance-filter fixture, plus 3 refresh-safety cases (page-1 failure throws, unexplained-empty throws, explicit-empty accepted, later-page failure doesn't lose earlier rows) |
| `backend/testCustomHtmlNewCandidates.js` (extended) | Added 10x Genomics / `careers.kula.ai` — real static same-origin job board, run through the actual `fetchCustomHtmlJobs`/`normalizeCustomHtmlJob` path; plus a unit check that an off-host job link is never treated as same-site |
| `backend/fixtures/customHtml/10x-genomics-*.html` | New — modeled on WebFetch-confirmed real structure (titles, locations, per-job URLs) |

## 3. Tests actually executed and results
```
node --test backend/testCustomHtml.js backend/testCustomHtmlNewCandidates.js \
             backend/testSuccessFactors.js backend/testWorkable.js \
             backend/testPinpoint.js backend/testClinchTalent.js
→ 47/47 pass
```
(18 pre-existing + 3 custom_html-candidates + 9 SuccessFactors + 6 Workable + 6 Pinpoint + 5 ClinchTalent.) `node -c` syntax-checked on every changed file.

## 4. Priority 1 — the 10 existing-adapter candidates

| Company | ats_type | ats_identifier (exact) | Status | Notes |
|---|---|---|---|---|
| Bio-Rad Laboratories | `clinchtalent` | `careers.bio-rad.com` | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN | Confirmed live, 136 real postings incl. "Sales Account Manager," "CDG Inside Sales Representative." **Known gap**: `clinchtalent.js` hardcodes `location_raw: ""` — the list page shows locations next to titles but the current regex doesn't capture them. Not fixed this round (would require real markup, not a guess) — flagged as a location-integrity gap to fix with live page source. |
| Align Technology | `pinpoint` | `jobs.aligntech.com` | CONFIG_RESOLVED_NEEDS_TEST | Adapter fixed this round to support the custom domain; no live job titles seen via WebFetch (landing page only) so extraction itself isn't confirmed yet. |
| Apellis Pharmaceuticals | `workday` | `teamapellis\|wd108\|???` | MANUAL_REVIEW | Tenant + wdNumber confirmed (from Round 1); exact `site` slug unconfirmed — one guess (`APELLIS`) 404'd, didn't guess further per "don't spend excessive credits repeatedly probing." |
| Cytokinetics | `workday` | `cytokinetics\|wd1\|Cytokinetics` | CONFIG_RESOLVED_NEEDS_TEST | Confirmed from Round 1's WebFetch (`cytokinetics.wd1.myworkdayjobs.com/Cytokinetics`); this round's re-fetch was blocked by the environment (see below), identifier unchanged. |
| Bracco Diagnostics | `workday` (likely) | `bracco\|wd103\|BraccoCareers` | MANUAL_REVIEW | Two links seen (Workday and Dayforce) — which is primary/current is still unresolved; re-fetch this round was blocked. |
| Kiniksa Pharmaceuticals | `greenhouse` | `kiniksapharmaceuticals` | CONFIG_RESOLVED_NEEDS_TEST | Confirmed board token from the board's own URL (`boards.greenhouse.io/kiniksapharmaceuticals`) — matches `greenhouse.js`'s format exactly. |
| Amneal Pharmaceuticals | `oraclehcm` | `hcfa.fa.us2.oraclecloud.com\|CX_1` (siteNumber assumed default) | MANUAL_REVIEW | Domain confirmed live; exact `siteNumber` not confirmed — `oraclehcm.js`'s own comment says most tenants default to `CX_1` if unclear, but that's an assumption, not a confirmation. |
| Midwest Veterinary Supply | `adp` | `293ebbc2-72a4-4413-bd7b-e06ac6d58a7e` | CONFIG_RESOLVED_NEEDS_TEST | Exact CID confirmed straight from the employer's own careers-page link — high confidence, matches `adp.js`'s format precisely. |
| Supernus Pharmaceuticals | **NOT `ukg` as assumed** | n/a | **NEEDS_ADAPTER** | Real site is `gusea1p01.rec.pro.ukg.net/SUP1013SUPR` — this is **UKG Pro Recruit**, a different product/domain than what `ukg.js` actually supports (`recruiting[2].ultipro.com`, the older UltiPro product). Confirmed by reading the adapter's own code, not guessed. The existing adapter cannot reach this URL at all. Worth a reusable extension later if other employers turn out to be on the same `rec.pro.ukg.net` platform — not built this round per the "don't build new adapters for one employer" instruction. |
| Guerbet | `successfactors` | `careers.guerbet.com` | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN | Confirmed directly: `careers.guerbet.com/search/` is a live CSB results page with 25+ real postings — the exact host the new `successfactors.js` expects, no separate tenant host to hunt for. |

**Correction, not previously noted**: last round's Nonin Medical finding (`recruiting2.ultipro.com`) *does* match `ukg.js`'s expected format — that one is a genuine UKG/UltiPro fit. Supernus is the one that isn't, despite both being labeled "UKG" in casual research notes. Same brand name, two different platforms — worth remembering for future candidates.

## 5. Priority 2 — 10x Genomics
**Resolved without a new adapter.** `careers.kula.ai/10xgenomics` is a real, static, server-rendered job board — confirmed via WebFetch (no JS-rendering language, real `<a href>` links per posting, no pagination needed for the current job count). Every posting link shares the same host as the listing page, which satisfies `fetchCustomHtmlJobs`'s same-origin safety rule (the same rule that blocks Nestlé Purina). Built a representative fixture and ran it through the real `fetchCustomHtmlJobs`/`normalizeCustomHtmlJob` path — 3/3 tests pass, including a check that a nationwide "District Sales Manager, BioPharma" territory is preserved as `"United States"`, not silently swapped for the Pleasanton, CA headquarters.

**Config:** `ats_type: custom_html`, `careers_url: https://careers.kula.ai/10xgenomics`. Status: **READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN**.

## 6. Priority 3 — Castle Biosciences / ApplicantPro
**Round 1's "adapter bug" finding was mistaken — corrected here.** The `www.applicantpro.com/openings/{company}/jobs` URL is just a redirect (302) to `{company}.applicantpro.com/jobs/`, which is exactly what `applicantpro.js` already fetches directly. There is no dual-URL-shape problem to fix; the adapter's assumed shape was right all along, and the existing `ats_identifier: "castlebiosciences"` needs no change. `applicantpro.js` is left as-is. Status: **CONFIG_RESOLVED_NEEDS_TEST** (unchanged from the stored config — the remaining uncertainty is the unverified `domain_id` regex and JSON field names the file's own header already flags, not the URL).

## 7. Priority 4 — IDEXX / Phenom
Confirmed live: `careers.idexx.com` is Phenom-People-hosted (CDN path `CareerConnectResources/pp/IDEXUS/`). `phenom.js` expects the employer's Phenom-hosted *hostname* itself (not a company code) — so `ats_identifier: "careers.idexx.com"`, `ats_type: "phenom"`. Status: **CONFIG_RESOLVED_NEEDS_TEST**.

## 8. Priority 5 — SuccessFactors
No new probing beyond what Round 1 already confirmed (Astellas, Boehringer Ingelheim, Boston Scientific, Olympus, Teleflex, Getinge, Terumo, DiaSorin, Dentsply Sirona, KARL STORZ), per the "don't spend excessive credits repeatedly probing" instruction — their identifiers are unchanged from Round 1's report. All 10 stay **READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN**. Guerbet is added to this family this round (§4).

## 9. Priority 6 — deprioritized, not investigated further this round
Applied Medical/Incyte (Jibe), ZOLL Medical, SOPHiA GENETICS, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA — unchanged from Round 1's classification. No new one-off adapters were built for any of these, per instruction.

## 10. Merit Medical — confirmed, not executed
Re-checked: `proposed_enrollment_changes.sql` from Round 1 still contains exactly `ats_identifier = 'merit|wd503|Merit'` for UUID `7e3289d4-afdb-4902-8a1b-97c6345d1c34`. Confirmed consistent with this round's findings. **Not run.**

## 11. Environment note (why some fetches are missing this round)
Several WebFetch calls against `*.myworkdayjobs.com`, `boards.greenhouse.io`, and `*.rec.pro.ukg.net` this round returned `PROVENANCE_REQUIRED` (an approval step that didn't complete) or `ROBOTS_DISALLOWED`, rather than page content — this is an environment/tool-access limitation, not a finding about those employers. Where Round 1 had already confirmed the same host, that finding is carried forward rather than re-guessed; where it hadn't (Apellis's exact site slug, Bracco's Workday-vs-Dayforce question, Amneal's siteNumber), those stay MANUAL_REVIEW rather than being guessed at.

## 12. Existing employer UUIDs for UPDATE
| UUID | Company | Change |
|---|---|---|
| `7e3289d4-afdb-4902-8a1b-97c6345d1c34` | Merit Medical Systems | `ats_identifier` → `merit\|wd503\|Merit` (confirmed both rounds) |
| `3043b184-854d-4ab2-85ba-546a6cf08075` | IDEXX Laboratories | `ats_type` → `phenom`, `ats_identifier` → `careers.idexx.com` |
| `a6d523e2-7d47-452c-b941-da4f9e15a0d1` | 10x Genomics | `ats_type` → `custom_html`, `careers_url` → `https://careers.kula.ai/10xgenomics` |
| `efce93c7-4b16-4510-931d-6649ebf807d9` | Castle Biosciences | **No change** — config already correct, contrary to Round 1's note |

## 13. New employer records proposed (not inserted)
| Company | ats_type | ats_identifier / careers_url | industry | Status |
|---|---|---|---|---|
| Bio-Rad Laboratories | clinchtalent | `careers.bio-rad.com` | Life Sciences | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Guerbet | successfactors | `careers.guerbet.com` | Medical Imaging | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Align Technology | pinpoint | `jobs.aligntech.com` | Medical Devices | CONFIG_RESOLVED_NEEDS_TEST |
| Kiniksa Pharmaceuticals | greenhouse | `kiniksapharmaceuticals` | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Midwest Veterinary Supply | adp | `293ebbc2-72a4-4413-bd7b-e06ac6d58a7e` | Veterinary Distribution | CONFIG_RESOLVED_NEEDS_TEST |
| Cytokinetics | workday | `cytokinetics\|wd1\|Cytokinetics` | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Amneal Pharmaceuticals | oraclehcm | `hcfa.fa.us2.oraclecloud.com\|CX_1` | Pharmaceutical | MANUAL_REVIEW (siteNumber assumed) |
| Apellis Pharmaceuticals | workday | `teamapellis\|wd108\|?` | Pharmaceutical | MANUAL_REVIEW (site slug unconfirmed) |
| Bracco Diagnostics | workday or dayforce | unresolved | Medical Imaging | MANUAL_REVIEW |
| Supernus Pharmaceuticals | — | — | Pharmaceutical | NEEDS_ADAPTER (wrong platform for existing `ukg.js`) |
| TG Therapeutics *(carried from Round 1)* | custom_html | `https://www.tgtherapeutics.com/about-us/join-us/` | Pharmaceutical | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |

## 14. SQL prepared but not executed
See `proposed_enrollment_changes.sql` (updated this round with the same discipline — the Merit Medical fix stays the only uncommented, ready-to-run statement; everything else is a commented draft).

## 15. Explicit list — still needs a live production validation run before READY_LIVE_VALIDATED
Every row marked READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN or CONFIG_RESOLVED_NEEDS_TEST above: Bio-Rad, Guerbet, Align Technology, Kiniksa, Midwest Vet Supply, Cytokinetics, 10x Genomics, IDEXX, Castle Biosciences, TG Therapeutics, and all 10 SuccessFactors employers (Astellas, Boehringer Ingelheim, Boston Scientific, Olympus, Teleflex, Getinge, Terumo, DiaSorin, Dentsply Sirona, KARL STORZ). None of this sandbox's fixture tests substitute for that.

## 16. Explicit list — unsupported / inconclusive
- **Supernus Pharmaceuticals** — NEEDS_ADAPTER, wrong platform for `ukg.js`.
- **Apellis Pharmaceuticals** — MANUAL_REVIEW, Workday site slug unconfirmed.
- **Bracco Diagnostics** — MANUAL_REVIEW, Workday vs. Dayforce unresolved.
- **Amneal Pharmaceuticals** — MANUAL_REVIEW, Oracle HCM siteNumber assumed not confirmed.
- **Novo Nordisk, Daiichi Sankyo, Kedrion Biopharma, Ambu** — unchanged from Round 1 (UNSUPPORTED/NEEDS_ADAPTER).
- Priority 6 group (Applied Medical, Incyte, ZOLL, SOPHiA GENETICS, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA) — unchanged from Round 1, not re-investigated.
- **Bio-Rad's location gap** — `clinchtalent.js` cannot currently produce `location_raw` for any employer on that platform; needs real page markup to fix properly.

## 17. NEXT PRODUCTION STEPS (safest order for a repository-connected session)
1. **Run Merit Medical's one-line SQL fix first** — it's a database correction to an already-live employer, zero enrollment risk, and immediately testable by re-running ingestion for that one employer.
2. **Live-test the two highest-confidence new sources next**: Bio-Rad (Clinch Talent) and Guerbet (SuccessFactors) — both had real job data independently confirmed twice (WebFetch + adapter fixture), lowest risk of the ADD candidates.
3. **Live-test 10x Genomics** (custom_html/kula.ai) and **TG Therapeutics** (custom_html) next — both are UPDATE/ADD candidates validated through the actual extraction code path this session, not just research.
4. **Then the CONFIG_RESOLVED_NEEDS_TEST group**: Align Technology, Kiniksa, Midwest Vet Supply, Cytokinetics, IDEXX, Castle Biosciences — configs are set, just unconfirmed against live traffic.
5. **Then the 10 SuccessFactors employers** as a batch, since they all share the one rewritten adapter — a single successful run against any one of them meaningfully de-risks the rest.
6. **Leave MANUAL_REVIEW and NEEDS_ADAPTER items (Supernus, Apellis, Bracco, Amneal, Novo Nordisk, Daiichi Sankyo, Kedrion, Ambu, and the Priority 6 group) for a follow-up round** — each needs either a live-access confirmation step or new adapter work outside this round's "existing adapters first" scope.
7. Before enrolling anything, re-run `npm run test-all` in the repository-connected session to confirm nothing about the live environment (Node version, dependency versions) changed the passing result.
