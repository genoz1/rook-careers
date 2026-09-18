# ROOK Source Validator — read-only production source check

Built because this sandbox cannot make live outbound HTTP requests to
employer career sites (confirmed directly against the ROOK runtime, not
assumed — see `ROOK_source_validation_report_round3.md`'s handoff note and
the "CAN LIVE ROOK INGESTION RUN HERE: NO" finding). This tool exists so a
session that IS connected to the real ROOK DigitalOcean environment can run
one command instead of re-deriving three rounds of adapter/config research.

**This tool has not been run against any live employer site.** Everything
below was verified with `node -c`, unit tests against real adapter code with
`global.fetch` stubbed (the same pattern every other adapter test in this
repo already uses), and a full re-run of the pre-existing test suite. It has
never made a real network request.

## FOR WORK — DO ONLY THIS

1. Unzip this repo where the real ROOK backend already runs (or a scratch
   checkout with the same `.env` / Supabase credentials available) — do
   **not** deploy it publicly, do **not** push it to `genoz1/rook-careers`
   unless separately asked.
2. `npm install`
3. `npm run validate-sources -- --batch 1`
4. Retrieve `backend/validation-results.json` and
   `backend/validation-results.md` and send them back.
5. Stop there. Do not run `npm run ingest`, do not touch the database, do
   not run any `.sql` file, do not enroll/activate anything. This tool
   cannot write to the database even if asked to (see below) — but the
   surrounding environment can, so don't run anything else in it.

That's the whole job. Everything past this point is background for whoever
reviews the results.

## What this tool does

`backend/validateSources.js` runs ROOK's **real** adapter fetch and
normalize functions (`backend/adapters/*.js` — the exact same code
`backend/ingest.js` calls in production) against each employer in
`backend/sourceValidationManifest.json`, and reports what came back. It
never inserts, updates, upserts, or deletes anything, and it never closes a
job or changes an employer's config or `sync_status`.

```
npm run validate-sources -- --company "TG Therapeutics"
npm run validate-sources -- --batch 1
npm run validate-sources -- --all
```

Output: `backend/validation-results.json` (full detail, meant for another
AI reviewer or a script) and `backend/validation-results.md` (a summary
table plus per-company detail, meant for a human). Both are regenerated
each run and both are safe to hand to someone without giving them database
access — see redaction below.

## How the read-only guarantee actually holds

Three separate things, all independently true and all covered by
`backend/testSourceValidator.js`:

1. **It never imports a Supabase client.** `validateSources.js` never
   requires `@supabase/supabase-js` and never constructs a client
   (`createClient(...)`). There is no code path in this file that could
   open a database connection, writable or read-only.
2. **It never requires `backend/ingest.js`.** `ingest.js` builds a
   *writable, service-role* Supabase client at module load time,
   unconditionally, the moment it's required — before any function in it
   even runs. Importing it here at all, even just to reuse a helper, would
   undo the guarantee. Instead, `validateSources.js` imports only the
   individual adapter modules (`backend/adapters/*.js`), which have no
   database code in them at all, and reimplements just the routing
   (`ats_type` → which adapter to call) as its own small `dispatch()`
   function — not a duplicate of any adapter's extraction or normalization
   logic, just the same switch `ingest.js` uses to pick which adapter to
   call. `testSourceValidator.js` checks that every `ats_type` this
   dispatch table claims to support is really one of `ingest.js`'s own
   cases, so the mirror can't silently drift from the real thing.
3. **No write-verb call pattern appears anywhere in the file.** A test
   reads `validateSources.js`'s own source text and asserts it contains no
   `.insert(`, `.update(`, `.upsert(`, `.delete(`, or `supabase.from(` — not
   because those would be reachable (they can't be, per #1 and #2), but as
   a second, independent check that would catch a future edit that
   accidentally introduces one.

Employer data comes entirely from the local
`backend/sourceValidationManifest.json` file — company name, website,
careers URL, industry, `ats_type`/`ats_identifier`, and any special
settings — not from a database lookup. There is no `SELECT` against
production anywhere in this tool.

## Merit Medical — validate-only, never written back

The manifest includes Merit Medical Systems with the corrected Workday
identifier (`merit|wd503|Merit` — the tenant number `wd1` stored in
production is wrong; `wd503` is what Round 1 confirmed live). This entry
exists **only so the corrected identifier can be validated** before anyone
touches the real record. Running the validator against it never writes
anything — same as every other candidate — but this one in particular
should not be enrolled by copy-pasting a passing result; the actual
production fix is the one already-prepared, not-yet-run `UPDATE` statement
in `proposed_enrollment_changes.sql`, and that decision belongs to a human,
separately.

## Validation statuses

| Status | Meaning |
|---|---|
| `PASS_LIVE` | Real jobs extracted and normalized cleanly, or a confirmed genuine zero (see below). |
| `PASS_WITH_WARNINGS` | Passed, but with something worth a human glance — some jobs failed to normalize while others succeeded, or over half the batch has no `location_raw` (a known gap on some adapters, e.g. ClinchTalent). |
| `FAIL_SOURCE` | Could not reach or get a usable response from the source at all (network error, timeout, non-2xx). |
| `FAIL_EXTRACTION` | Reached the source, but couldn't find or parse job listing content on it (empty result with no explicit "no jobs" evidence, unexpected response shape, missing expected fields). |
| `FAIL_NORMALIZATION` | Raw jobs came back, but every single one failed to normalize. |
| `FAIL_INCOMPLETE` | Normalized jobs are missing a title or a source URL on one or more entries. |
| `FAIL_SUSPICIOUS_EMPTY` | Zero jobs returned, from an adapter that has no built-in way to confirm that's a genuine zero rather than a blocked/broken fetch. **Never auto-passed.** |

**Zero jobs is never an automatic pass.** Four adapters
(`successfactors`, `clinchtalent`, `applicantpro`, `custom_html`) were
specifically fixed in Rounds 1–3 to only return an empty array after
finding positive evidence of a genuine zero-openings page (explicit "no
results" text, or an equivalent structured signal) — for those, a
confirmed empty result is `PASS_LIVE`. Every other adapter returning zero
jobs is `FAIL_SUSPICIOUS_EMPTY` by design, because in production,
`ingest.js` closes every existing job for an employer whose adapter returns
`[]` — treating an ambiguous empty as a pass would risk exactly that.

## Redaction

Before either output file is written, every free-text field (`error`,
`warning`, normalization error messages, sample job titles/locations/URLs)
passes through `redact()`, which strips anything shaped like a bearer
token, an `api_key=`/`token=`/`access_token=`/`password=` query parameter,
or an `Authorization: ...` header value. This runs twice — once when each
result is built, and again defensively right before the files are written
— so no code path can skip it. `testSourceValidator.js` asserts the output
files never contain a raw secret-shaped string that was fed in.

The validator also never prints full job descriptions to the terminal or
into the output files — only a title, normalized location,
territory/multi-location info (when present), the "View Original" URL, and
a separate application-destination URL only when it differs from the
source URL.

## Batches (safest-first rollout order, from Round 3)

24 candidates across 6 batches, generated from the cumulative Round 1–3
report data (`sourceValidationManifest.json`'s own `generatedFrom` field
names the source). Only `READY_FIXTURE_VALIDATED_NEEDS_LIVE_RUN` and
`CONFIG_RESOLVED_NEEDS_TEST` candidates are included — nothing
`NEEDS_ADAPTER`, `MANUAL_REVIEW`, or otherwise unresolved made it into a
default batch.

- **Batch 1** — Merit Medical Systems (validate-only), Bio-Rad
  Laboratories, Guerbet, TG Therapeutics
- **Batch 2** — 10x Genomics, IDEXX Laboratories, Castle Biosciences,
  Align Technology
- **Batch 3** — Kiniksa Pharmaceuticals, Midwest Veterinary Supply,
  Cytokinetics, Apellis Pharmaceuticals
- **Batch 4** — Amneal Pharmaceuticals, Bracco Diagnostics, Astellas
  Pharma, Boehringer Ingelheim
- **Batch 5** — Boston Scientific, Olympus, Teleflex, Getinge
- **Batch 6** — Terumo, DiaSorin, Dentsply Sirona, KARL STORZ

## Tests — what was actually run, and the results

All run fresh in this sandbox (never against a live employer site —
every adapter call in every test is against a stubbed `global.fetch`, the
same convention `testApplicantPro.js`/`testClinchTalent.js`/etc. already
used before this phase):

```
node --test backend/testCustomHtml.js backend/testCustomHtmlNewCandidates.js \
  backend/testSuccessFactors.js backend/testWorkable.js backend/testPinpoint.js \
  backend/testClinchTalent.js backend/testApplicantPro.js backend/testSourceValidator.js
```
→ **66/66 passed** (51 pre-existing adapter/fixture tests + 15 new
`testSourceValidator.js` tests: CLI company/batch/all selection, unknown
company rejection, a successful real-adapter extraction through to
`PASS_LIVE`, a source failure through to `FAIL_SOURCE`, a suspicious-empty
result through to `FAIL_SUSPICIOUS_EMPTY`, a confirmed-empty
SuccessFactors result through to `PASS_LIVE`, a forced normalization
failure through to `FAIL_NORMALIZATION`, one employer failing without
stopping the rest of a batch, `redact()`'s own behavior, and that the
written output files never contain an unredacted secret).

```
node backend/testJobEligibility.js     → 114 passed, 0 failed
node backend/testTrialFlow.js          → 59 passed, 0 failed
node backend/testV6EmailCode.js        → passed
node backend/testDailyDigestLocation.js → passed
```

`backend/testUiCopy.js` was **not run as part of this phase's fix
scope** — it has a known, pre-existing, unrelated failure (a homepage
hero-CTA regression, first flagged in Round 2) that earlier rounds were
explicitly told not to fix, and that instruction still stands here. It
was not touched.

## Files changed or added this phase

- **Added** `backend/sourceValidationManifest.json` — the 24-candidate,
  6-batch manifest described above.
- **Added** `backend/validateSources.js` — the validator itself.
- **Added** `backend/testSourceValidator.js` — its test suite (15 tests).
- **Added** `VALIDATOR_README.md` — this file.
- **Modified** `package.json` — added `validate-sources` and
  `test-source-validator` npm scripts; wired the latter into `test-all`.
- **Not modified**: every adapter file, every prior test file, the prior
  validation reports, `proposed_enrollment_changes.sql`,
  `backend/ingest.js`, and everything else in the repo.
