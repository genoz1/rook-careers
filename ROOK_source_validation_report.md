# ROOK Careers — Source Adapter Validation Report
Sept 18, 2026. Nothing in this report has been deployed, pasted into GitHub, or run against the database. Code changes live only in the extracted repo copy in this session's workspace.

## 1. Code changes

- **`backend/adapters/successfactors.js` — full rewrite.** Old adapter targeted a public JSON REST endpoint (`/api/rest/2.0/posting`) that doesn't exist for SAP SuccessFactors Career Site Builder tenants — this was the single shared root cause of all 4 production failures (Astellas, Boehringer Ingelheim, Daiichi Sankyo, Novo Nordisk), not 4 separate bugs. New version scrapes the real server-rendered `/search/?q=` results page and `/job/{slug}/{id}/` detail pages, with pagination auto-discovery and two location-extraction strategies (results-row text, falling back to the city/state/zip encoded in the detail URL's own slug).
- **Same file — refresh-safety fix.** Found while building the "empty tenant" test case: a tenant returning zero job rows on page 1 was being treated as a legitimate empty result. That would let `ingest.js` close every existing job for that employer on a blocked page, cookie-consent wall, or JS-only results grid. Fixed: zero rows only counts as genuine if the page's own visible text explicitly says so ("no results found," etc.); otherwise the adapter throws, preserving the existing-jobs-stay-open safeguard.
- **`backend/adapters/workable.js` — multi-location fix.** Previous version only read the single `raw.location` object. Workable's documented public API schema also carries a `raw.locations` array for multi-location postings — reading only the singular field silently collapsed a multi-state/national territory job down to one location, which matches the "Ascendis Pharma dropped locations" description in the task brief. (That brief's claim that a fix for this was already published could not be confirmed anywhere in the repository — grepped for "ascendis," zero matches, and the file's location logic was unchanged from its original single-field form. This is a new fix, not a verification of an existing one.)
- **`package.json`** — added `test-successfactors`, `test-custom-html-candidates`, `test-workable` scripts, wired into `test-all`.

## 2. Tests and representative fixtures

| Suite | File | Fixtures added |
|---|---|---|
| SuccessFactors | `backend/testSuccessFactors.js` | `backend/fixtures/successfactors/` — single-page table-skin tenant, 2-page paginated div-skin tenant, explicit-"no results" tenant, blocked/cookie-wall tenant (no rows, no explicit-empty text) |
| custom_html new candidates | `backend/testCustomHtmlNewCandidates.js` | `backend/fixtures/customHtml/tg-therapeutics*.html` — real "no ATS" careers page, 4 of its ~17 actual postings, run through the full `fetchCustomHtmlJobs`/`normalizeCustomHtmlJob` path |
| Workable | `backend/testWorkable.js` | inline synthetic JSON matching Workable's documented schema (no separate fixture files) |

All fixtures are synthetic/reconstructed from WebFetch structural reads, not byte-identical downloads — this sandbox has no outbound access to arbitrary external hosts (confirmed, and one false-positive from the sandbox's own proxy was caught and discarded rather than treated as live data). Documented in each fixtures/README.md, same convention the repo's other "not verified live" adapters already use.

## 3. Tests actually executed and their results

```
npm run test-custom-html              → 18/18 pass  (pre-existing suite, unaffected)
npm run test-custom-html-candidates   →  1/1  pass  (new)
npm run test-successfactors           →  9/9  pass  (new)
npm run test-workable                 →  6/6  pass  (new)
```
34/34 total. `node -c` syntax-checked on every changed/new file.

## 4. Full candidate status table (49 researched candidates)

### SuccessFactors (14)
| Company | Status | Reason |
|---|---|---|
| Astellas, Boehringer Ingelheim, Boston Scientific, Olympus, Teleflex, Getinge, Terumo, DiaSorin, Dentsply Sirona, KARL STORZ | MANUAL_REVIEW | Real job data confirmed via WebFetch; adapter built + passes representative fixtures; not yet run against live tenant HTML — one real ingestion run away from READY |
| Daiichi Sankyo, Kedrion Biopharma, Ambu | NEEDS_ADAPTER | No visible job content returned; can't distinguish JS-rendering from a cookie wall without live access |
| Novo Nordisk | UNSUPPORTED (by this adapter) | Stored host is wrong; real site is "classic" SuccessFactors (different platform, different URL shape) |

### custom_html (27)
| Company | Status | Reason |
|---|---|---|
| TG Therapeutics | **READY** (pending 1 live confirmation) | Only candidate validated end-to-end through the real extraction path this session |
| Bio-Rad, Align Technology, Apellis, Cytokinetics, Bracco, Kiniksa, Amneal, Midwest Vet Supply, Supernus, Guerbet (10) | NEEDS_ADAPTER → use existing adapter | Each is actually running Clinch Talent / Pinpoint / Workday / Workday / Workday-or-Dayforce / Greenhouse / Oracle HCM / ADP / UKG / SuccessFactors — ROOK has adapters for all of these already; this is a config fix, not new extraction work |
| Applied Medical, Incyte, Nonin Medical, Natus Medical, Nihon Kohden, Immunocore, Nestlé Purina | NEEDS_ADAPTER (new platform / cross-origin block) | Jibe (×2 — one adapter would cover both), UltiPro, Dayforce, HRMDirect, Salesforce Recruiting, and a cross-origin job feed the adapter's own same-origin safety rule correctly refuses |
| ZOLL Medical | MANUAL_REVIEW | HubSpot careers module; `/careers-listing` itself not yet checked directly |
| SOPHiA GENETICS, Standard Process, bioMérieux, Legend Biotech, Zomedica, Octapharma USA | MANUAL_REVIEW | WebFetch returned blank content; can't tell JS-only rendering from a fetch artifact without live access |
| Biohaven | UNSUPPORTED | No job listings or ATS link present at all right now |
| Grifols | UNSUPPORTED | External portal, platform not yet identified |

### UPDATE family — non-SuccessFactors (6)
| Company | Status | Reason |
|---|---|---|
| **Merit Medical Systems** | **Confirmed fix, ready to run** | Stored Workday tenant `wd1` should be `wd503` — confirmed live via WebFetch |
| IDEXX Laboratories | NEEDS_ADAPTER | Migrated off Workday to Phenom People; needs the real Phenom identifier confirmed |
| 10x Genomics | NEEDS_ADAPTER / promising custom_html lead | Stored Greenhouse config is stale; site now redirects to `careers.kula.ai/10xgenomics`, a real job board with individual links — worth a custom_html fixture test next session |
| Castle Biosciences | NEEDS_ADAPTER (adapter bug) | Confirmed still ApplicantPro, but at a URL shape (`www.applicantpro.com/openings/{company}/jobs`) the adapter doesn't currently handle |
| Takeda, Revvity | MANUAL_REVIEW | TalentBrew/Avature signals seen; neither confirms nor rules out the stored Workday config |

### Ascendis Pharma (workable, ADD)
Adapter fix made and unit-tested (see §1); genuinely a new platform for this employer, real job board confirmed live. NEEDS one live ingestion run before READY.

## 5. Exact employers successfully validated (extraction path actually run, not just researched)
- **TG Therapeutics** (new) — `custom_html`, 4/4 sample postings correctly extracted, statuses, locations, and application destinations all correct in the test.
- **Workable location logic** — validated in isolation (not tied to one employer) against Workable's documented schema; applies to any current/future `workable`-type employer, including Ascendis Pharma once enrolled.

No employer's *live* extraction was confirmed this session — this sandbox cannot reach any of these hosts directly. Everything above is "passes ROOK's own logic against a faithful representative fixture," which is the most this environment can prove; the next real ingestion run is still the actual test.

## 6. Exact existing employer UUIDs to update
| UUID | Company | Change |
|---|---|---|
| `7e3289d4-afdb-4902-8a1b-97c6345d1c34` | Merit Medical Systems | `ats_identifier`: `merit\|wd1\|Merit` → `merit\|wd503\|Merit` — **ready to run** |
| `3043b184-854d-4ab2-85ba-546a6cf08075` | IDEXX Laboratories | `ats_type` → `phenom` — needs real identifier first |
| `a6d523e2-7d47-452c-b941-da4f9e15a0d1` | 10x Genomics | `careers_url` → `https://careers.kula.ai/10xgenomics` — needs a fixture-tested custom_html pass first |
| `efce93c7-4b16-4510-931d-6649ebf807d9` | Castle Biosciences | adapter fix needed before any config change helps |
| `a6938cd7-59e6-4b83-bd7a-631caf4fc630` | Astellas Pharma | `sync_status` → `pending` once SuccessFactors adapter gets a live run — identifier unchanged |
| `a25f7f4d-0483-4b99-a62a-02ce2fef1157` | Boehringer Ingelheim | same as above |
| `e8d541fc-d599-41f3-9228-4c25cf71be60` | Daiichi Sankyo | leave as-is; NEEDS_ADAPTER |
| `ce0a5057-e9e3-4b73-ae85-d5116285d844` | Novo Nordisk | leave as-is; wrong platform entirely |
| `317a6990-82e0-421e-9722-351791ff5287` | Takeda | leave as-is; inconclusive |
| `7ff33978-d02c-46f3-b8c7-9bb0301c34be` | Revvity | leave as-is; inconclusive |

## 7. New employers ready for enrollment
**None are being enrolled/activated in this session** (explicit instruction). The one closest to ready: **TG Therapeutics**, validated through the real extraction path. Everything else in `proposed_enrollment_changes.sql` is commented out as a draft, not a statement to run.

## 8. Required config for the one READY employer
| Field | Value |
|---|---|
| `ats_type` | `custom_html` |
| `careers_url` | `https://www.tgtherapeutics.com/about-us/join-us/` |
| `company_website` | `https://www.tgtherapeutics.com` |
| `industry` | Pharmaceutical |
| Special settings | None — no territory splitting, no special extraction settings needed; applications are by email |

## 9. Remaining failures and technical reasons
Covered inline in every table above (§4) — every non-READY row states its specific reason (wrong recorded platform, cross-origin block, adapter URL-shape mismatch, inconclusive fetch, no content, etc.), not a generic "failed."

## 10. SQL/enrollment changes prepared but not executed
See `proposed_enrollment_changes.sql` (delivered alongside this report). One statement is a confirmed, ready-to-run fix (Merit Medical); everything else is commented out as a documented draft for the next session, deliberately not something to run yet.

---

## The one discrepancy worth restating plainly
The task brief's claim — "Ascendis Pharma successfully returned jobs... A small location-mapping fix was subsequently published" — doesn't match this repository. No reference to "ascendis" exists anywhere in the codebase, Ascendis Pharma isn't in the 312-employer baseline at all, and `workable.js`'s location logic was unchanged from its original single-field form before this session. The location-preservation problem the brief describes is real and plausible (and is now fixed, with tests), but the claimed prior fix was not something already in the repository — it's the fix made today.
