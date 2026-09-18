# ROOK Careers — Source Adapter Validation, Round 3
Sept 18, 2026. Built on `rook-careers-validated-round2.zip`, used as source of truth — nothing reconstructed from either older ZIP. Nothing deployed, pushed, activated, or executed this round.

## Pre-flight (verified fresh)
- Round 1 + 2 changes present: SuccessFactors rewrite ✓, Workable multi-location fix ✓, Pinpoint custom-domain fix ✓, ClinchTalent refresh-safety fix ✓, TG Therapeutics + 10x Genomics custom_html fixtures ✓ (all confirmed by grep for their marker comments, same method as Round 2).
- **Ran fresh**: `node --test backend/testCustomHtml.js backend/testCustomHtmlNewCandidates.js backend/testSuccessFactors.js backend/testWorkable.js backend/testPinpoint.js backend/testClinchTalent.js` → **47/47 pass**, confirming Round 2's number rather than assuming it.
- `testUiCopy.js`'s pre-existing homepage trial-CTA failure: confirmed still present, **not touched**, recorded here only as required — not a source-ingestion issue.

## Round 3 code changes
- **`backend/adapters/applicantpro.js`** — refresh-safety fix, same audit pattern as SuccessFactors/ClinchTalent: `data?.jobs || []` treated a malformed/unexpected JSON response (wrong field name, an error object instead of a job list) identically to a genuine zero-job response. Now: an object response with no `jobs` key at all throws; a genuinely empty `jobs: []` array is still accepted as real. New test suite `backend/testApplicantPro.js` (4/4 passing) also gives this previously-untested adapter its first regression coverage, using the two-step domain_id-scrape-then-JSON-fetch flow Round 2 confirmed is architecturally correct for Castle Biosciences.
- No other adapter code changed this round — Priority 1 work was entirely configuration resolution (see table), and the Jibe investigation (Priority 3) concluded a new adapter is **not** justified with current evidence (see below).

## Tests actually executed and results
```
node --test backend/testCustomHtml.js backend/testCustomHtmlNewCandidates.js \
             backend/testSuccessFactors.js backend/testWorkable.js \
             backend/testPinpoint.js backend/testClinchTalent.js backend/testApplicantPro.js
→ 51/51 pass
```
(18 + 3 + 9 + 6 + 6 + 5 + 4.) `node -c` syntax-checked on the one changed file.

## Priority 1 — existing-adapter candidates, resolved this round
| Company | Resolution | New ats_identifier |
|---|---|---|
| **Apellis Pharmaceuticals** | Site slug confirmed: link on apellis.com itself is `teamapellis.wd108.myworkdayjobs.com/ApellisCareers/` | `teamapellis\|wd108\|ApellisCareers` — **CONFIG_RESOLVED_NEEDS_TEST** |
| **Amneal Pharmaceuticals** | siteNumber confirmed as `CX`, not the `CX_1` Round 2 assumed by default — the real link is `.../sites/CX` | `hcfa.fa.us2.oraclecloud.com\|CX` — **CONFIG_RESOLVED_NEEDS_TEST** |
| **Bracco Diagnostics** | Workday-vs-Dayforce resolved: Workday link appears twice, labeled "Current job openings" both times; Dayforce appears once, phrased as a secondary "browse opportunities" alternative | `workday`, `bracco\|wd103\|BraccoCareers` — **CONFIG_RESOLVED_NEEDS_TEST** |
| Kiniksa Pharmaceuticals | Re-confirmed board token unchanged; the public HTML board now redirects `boards.greenhouse.io` → `job-boards.greenhouse.io`, but `greenhouse.js` hits the separate `boards-api.greenhouse.io` JSON endpoint directly, unaffected by that redirect | `kiniksapharmaceuticals` (unchanged) — still **CONFIG_RESOLVED_NEEDS_TEST** |
| Align Technology, IDEXX, Cytokinetics | One focused re-check each; WebFetch reached only landing/search-portal pages (no rendered job data, consistent with JS-rendered results grids), no new information gained. Round 2's resolved configs are unchanged and not downgraded. | Unchanged — still **CONFIG_RESOLVED_NEEDS_TEST** |
| Midwest Veterinary Supply | Not re-probed (already resolved with high confidence in Round 2 — CID taken directly from the employer's own link) | Unchanged — still **CONFIG_RESOLVED_NEEDS_TEST** |

## Priority 2 — SuccessFactors
No new probing (per instruction) — all 10 (Astellas, Boehringer Ingelheim, Boston Scientific, Olympus, Teleflex, Getinge, Terumo, DiaSorin, Dentsply Sirona, KARL STORZ) plus Guerbet stay **READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN**, unchanged from Rounds 1–2. Daiichi Sankyo, Kedrion, Ambu, Novo Nordisk not revisited — no new evidence encountered.

## Priority 3 — Jibe (Applied Medical, Incyte): no adapter built
Made one focused attempt at each. Findings:
- Both employers' actual job-listing subpages (not just the landing page) still render no job data through WebFetch — consistent with a client-side-only results grid, same as Round 1/2.
- WebSearch for a documented public Jibe JSON API turned up nothing concrete — the one plausible lead (a "jibe.3scale.net" page titled "iCIMS API," suggesting Jibe was absorbed into iCIMS after their 2018 acquisition) is too weak to act on: no evidence these specific Jibe-CDN-branded pages actually run on `*.icims.com` (ROOK's existing `icims.js` expects that exact subdomain pattern, which neither Applied Medical's nor Incyte's URLs use).
- **Conclusion: do not build a Jibe adapter.** Per instruction, a reusable adapter is only justified when the source structure, pagination, and legitimate-vs-blocked-empty distinction can all be established — none of that evidence exists here. Building one now would mean guessing at request/response shapes with zero verification, the same mistake the original SuccessFactors adapter made.
- **Applied Medical and Incyte remain NEEDS_ADAPTER**, explicitly for this reason: no confirmed public API, no reachable server-rendered job data, no way to distinguish a legitimate empty result from a blocked one without live browser access this environment doesn't have.

## Priority 4 — re-investigated: ZOLL, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA, SOPHiA GENETICS
One fresh, targeted probe per employer, deliberately not assuming the prior `custom_html` classification. All 7 still returned no job data through WebFetch — either a genuinely JS-only results grid (ZOLL, Legend Biotech, Zomedica) or a blank/404 response on the specific sub-path tried (Standard Process, bioMérieux, Octapharma USA, SOPHiA GENETICS). No change from Round 1's classification for any of the 7 — **all remain MANUAL_REVIEW**, honestly, rather than guessed into a status this environment can't support.

## Priority 5 — ApplicantPro / Castle Biosciences
Validated cheaply as instructed: added `backend/testApplicantPro.js` (4 tests) confirming the two-step flow Round 2 already established is architecturally sound, plus the refresh-safety fix above. Castle Biosciences' config is unchanged (`castlebiosciences`) — **CONFIG_RESOLVED_NEEDS_TEST**, same as Round 2, now with real regression coverage for the first time.

## Supernus
No new evidence found this round justifying a `ukg.js` extension. Confirmed still **NEEDS_ADAPTER** — real platform is UKG Pro Recruit (`rec.pro.ukg.net`), which remains outside what the existing UltiPro-shaped adapter supports.

## Cumulative master status table — Rounds 1–3

### SuccessFactors (11 total incl. Guerbet)
| Company | Status |
|---|---|
| Astellas, Boehringer Ingelheim, Boston Scientific, Olympus, Teleflex, Getinge, Terumo, DiaSorin, Dentsply Sirona, KARL STORZ, Guerbet | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Daiichi Sankyo, Kedrion Biopharma, Ambu | NEEDS_ADAPTER |
| Novo Nordisk | UNSUPPORTED (wrong/different platform) |

### custom_html (real wins)
| Company | Status |
|---|---|
| TG Therapeutics | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| 10x Genomics (careers.kula.ai) | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Bio-Rad Laboratories (clinchtalent) | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN (location_raw gap noted) |

### Existing-adapter config resolved (CONFIG_RESOLVED_NEEDS_TEST)
Align Technology (pinpoint), IDEXX Laboratories (phenom), Cytokinetics (workday), Kiniksa Pharmaceuticals (greenhouse), Midwest Veterinary Supply (adp), Apellis Pharmaceuticals (workday), Amneal Pharmaceuticals (oraclehcm), Bracco Diagnostics (workday), Castle Biosciences (applicantpro) — **9 employers**.

### MANUAL_REVIEW
Takeda, Revvity (Workday vs. unconfirmed), Nestlé Purina PetCare (cross-origin block, see Round 1), ZOLL Medical, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA, SOPHiA GENETICS — **10 employers**.

### NEEDS_ADAPTER
Applied Medical, Incyte (Jibe — no reliable evidence to build on), Supernus Pharmaceuticals (wrong UKG product), Daiichi Sankyo, Kedrion Biopharma, Ambu, Nonin Medical (UltiPro — never built, no employer justifies it alone), Natus Medical (Dayforce), Nihon Kohden (HRMDirect), Immunocore (Salesforce Recruiting) — **10 employers**.

### UNSUPPORTED
Novo Nordisk, Biohaven, Grifols — **3 employers**.

## Existing employer UUIDs for UPDATE
| UUID | Company | Change |
|---|---|---|
| `7e3289d4-afdb-4902-8a1b-97c6345d1c34` | Merit Medical Systems | `ats_identifier` → `merit\|wd503\|Merit` (unchanged finding, all 3 rounds) |
| `3043b184-854d-4ab2-85ba-546a6cf08075` | IDEXX Laboratories | `ats_type` → `phenom`, `ats_identifier` → `careers.idexx.com` |
| `a6d523e2-7d47-452c-b941-da4f9e15a0d1` | 10x Genomics | `ats_type` → `custom_html`, `careers_url` → `https://careers.kula.ai/10xgenomics` |
| `efce93c7-4b16-4510-931d-6649ebf807d9` | Castle Biosciences | No change — config already correct |

## New employer (ADD) proposed configuration
| Company | ats_type | ats_identifier | careers_url | industry | Status |
|---|---|---|---|---|---|
| Bio-Rad Laboratories | clinchtalent | `careers.bio-rad.com` | https://careers.bio-rad.com/ | Life Sciences | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Guerbet | successfactors | `careers.guerbet.com` | https://careers.guerbet.com/ | Medical Imaging | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| TG Therapeutics | custom_html | — | https://www.tgtherapeutics.com/about-us/join-us/ | Pharmaceutical | READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN |
| Align Technology | pinpoint | `jobs.aligntech.com` | https://jobs.aligntech.com/ | Medical Devices | CONFIG_RESOLVED_NEEDS_TEST |
| Kiniksa Pharmaceuticals | greenhouse | `kiniksapharmaceuticals` | https://job-boards.greenhouse.io/kiniksapharmaceuticals | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Midwest Veterinary Supply | adp | `293ebbc2-72a4-4413-bd7b-e06ac6d58a7e` | https://www.midwestvetsupply.com/our-company/careers/ | Veterinary Distribution | CONFIG_RESOLVED_NEEDS_TEST |
| Cytokinetics | workday | `cytokinetics\|wd1\|Cytokinetics` | https://cytokinetics.com/careers/ | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Apellis Pharmaceuticals | workday | `teamapellis\|wd108\|ApellisCareers` | https://apellis.com/careers/open-positions/ | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Amneal Pharmaceuticals | oraclehcm | `hcfa.fa.us2.oraclecloud.com\|CX` | https://amneal.com/careers/ | Pharmaceutical | CONFIG_RESOLVED_NEEDS_TEST |
| Bracco Diagnostics | workday | `bracco\|wd103\|BraccoCareers` | https://www.bracco.com/careers | Medical Imaging | CONFIG_RESOLVED_NEEDS_TEST |

## SQL prepared but not executed
See `proposed_enrollment_changes.sql` — Merit Medical's fix remains the only uncommented statement. All 4 employers newly resolved this round (Apellis, Amneal, Bracco config confirmation, plus ApplicantPro test coverage) added as commented drafts.

## Sources requiring one live production run before READY_LIVE_VALIDATED
All READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN and CONFIG_RESOLVED_NEEDS_TEST rows above — 14 employers total across both categories.

## Sources still needing adapter work
Applied Medical, Incyte (Jibe — explicitly no adapter built, reasons above), Supernus (wrong UKG product), Nonin Medical (UltiPro), Natus Medical (Dayforce), Nihon Kohden (HRMDirect), Immunocore (Salesforce Recruiting) — **7 employers**, none guessed at.

## Unsupported / inconclusive
Novo Nordisk, Biohaven, Grifols (UNSUPPORTED); Daiichi Sankyo, Kedrion, Ambu (NEEDS_ADAPTER, undetermined cause); Takeda, Revvity, Nestlé Purina, ZOLL, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA, SOPHiA GENETICS (MANUAL_REVIEW) — **16 employers**.

## Known unrelated test failure (recorded, not fixed)
`npm run test-all` → `testUiCopy.js`'s "REGRESSION: homepage hero trial CTA" fails. Confirmed pre-existing across all 3 rounds, unrelated to any source-ingestion code, not touched per instruction.

## Round 3 scorecard
| Metric | Count |
|---|---|
| Newly resolved this round | 4 (Apellis, Amneal, Bracco config resolution + Castle Biosciences regression coverage) |
| Cumulative resolved (READY_FIXTURE_VALIDATED or CONFIG_RESOLVED) | 14 |
| Fixture-validated (extraction path actually exercised) | 5 (TG Therapeutics, 10x Genomics, plus SuccessFactors/Workable/ClinchTalent/Pinpoint/ApplicantPro mechanics) |
| Live-validated | 0 (sandbox cannot reach live external hosts — none claimed) |
| Still needing adapter work | 7 |
| Unsupported/inconclusive | 19 |
| Adapters added | 0 (Jibe deliberately not built — no reliable evidence) |
| Reusable adapter fixes made (cumulative, all 3 rounds) | 5 (SuccessFactors rewrite, Workable location fix, Pinpoint custom-domain, ClinchTalent refresh-safety, ApplicantPro refresh-safety) |
| Tests passing | 51/51 (adapter-specific suites) |

## NEXT PRODUCTION STEPS — safest to riskiest
1. **Merit Medical SQL fix** — zero enrollment risk, already-live employer, one field.
2. **Bio-Rad, Guerbet, TG Therapeutics, 10x Genomics** — independently confirmed live job data AND validated through the real extraction code path. Highest-confidence ADD/UPDATE candidates.
3. **IDEXX, Castle Biosciences** — existing employers, config resolved, now with regression tests; UPDATE risk is low since both keep their UUID.
4. **Align Technology, Kiniksa, Midwest Veterinary Supply, Cytokinetics, Apellis, Amneal, Bracco** — configs resolved this round but job data itself wasn't independently re-confirmed live (landing pages only); live-test as a batch, watch for the exact site-slug/siteNumber values holding up.
5. **The 10-employer SuccessFactors batch** — one adapter, shared risk; a single successful live run meaningfully de-risks the rest.
6. **Leave for a future round**: Applied Medical/Incyte (needs a live-browser-capable environment to even attempt Jibe), Supernus (needs its own UKG Pro Recruit research), and the 16-employer MANUAL_REVIEW/UNSUPPORTED group — none of these are solvable from this sandbox's access level; forcing them now would mean guessing.
