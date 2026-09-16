# V7 Reno location repair — 2026-09-16

The live Reno snapshot used Diagnostics, 10 years of sales experience, and local territory. The shared V6 scorer and pre-repair V7 path reproduce the same scores for three observed records: Caris California South 85, GeneDx Long Island/Queens 75, and Tandem Leiden 80. Their inputs contain a California state centroid, the hamlet of Remote in Oregon, and incorrect Nevada coordinates respectively. V7 did not change the scoring formula.

V7 now checks job geography before ranking and again before returning an existing snapshot, on both sides of trial activation. State-only and generic remote locations cannot supply point mileage. Bare Leiden is excluded after verifying Tandem's original on-site Dutch posting. Only jobs with valid point locations within 300 miles are scored and returned. No remote, statewide, missing-location, or territory-preference exception bypasses that boundary. The database query uses nearby coordinate bounds; exact great-circle distance rejects bounding-box corners before scoring.

Unchanged valid records keep their scores and identities. Imprecise records are excluded; remaining saved scores are not recalculated. Both masked and unmasked responses apply the same boundary; purchasing does not rerun matching with different preferences. Anonymous output still uses the explicit preview allowlist.

The existing 400-job query cutoff is preserved for scoring performance. Existing snapshots are filtered in place without replacing them with a fresh search. No migration, shared job-row mutation, V6 edit, scoring-weight change, checkout change, or resume-processing change is part of this repair.

Run `node backend/testV7Location.js` from a checkout with the V7 baseline in git history. The test replays the three observed records, tests new ranking and old snapshot responses, checks masked output and account ownership, and verifies V6/shared files against the baseline. The route test runs in memory without binding a local port.

This is a conservative V7 location safeguard, not an audit of every employer listing. It can reduce match counts where job locations cannot substantiate a local match. Ingestion and the older shared job data remain a separate concern; yesterday's geocoding prevention cannot retroactively repair stored coordinates.
