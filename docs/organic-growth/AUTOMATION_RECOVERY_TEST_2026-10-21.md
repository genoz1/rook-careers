# ROOK automated publication recovery pilot — October 21, 2026

Branch: `codex/organic-growth-oct2026`. Local-only changes. No commit, push, deployment, production database access, external post, email, charge or payout was performed by the recovery pilot.

## Results

Run: `node --test backend/organicAcquisition/recoveryPilot.test.js`

18 tests passed, zero failed. A deterministic reserve of 23 posts reuses the existing curated guidance for ten career articles plus three initial tips. The test uses fake channels, fake destination checks, an injected clock and a simulation-only publisher. It never imports a live publishing client or loads credentials.

| Failure or scenario | Observed simulated result |
|---|---|
| Fresh verified broad counts | Count-based post delivered with observation date and sample caveat |
| Stale data | Refresh attempted; replacement data used automatically |
| Missing data and failed refresh | Career guidance selected and delivered |
| Suppressed aggregate cell | Non-statistical guidance delivered |
| Unexpected protected fields | Snapshot rejected; protected sentinels absent from publisher payload |
| Broken report or first guide link | Another working career guide selected |
| Same slot replay and serialized worker restart | One simulated submission |
| New slots | Different content selected within cooldown |
| Provider definitively rejects submission | Backoff respected; subsequent attempt delivered |
| Timeout after provider accepts | Receipt reconciliation confirms delivery without resubmission |
| Queued or unknown receipt | Not incorrectly counted as published |
| Unrelated channel or live adapter | Refused |
| All destinations temporarily unavailable | Explicit backlog; delivery succeeds when destinations recover |
| Six weeks of missing data | 18/18 slots delivered using distinct guidance posts |
| Fourteen weeks of missing data | 42/42 slots delivered at three slots/week; reuse allowed only after 30-day cooldown |
| Reserve exhausted by a burst exceeding intended cadence | Explicit backlog rather than fabricated content or false success |
| Future-dated counts | Rejected |

These are accelerated simulations, not fourteen weeks of live observations. The 42-slot run exercises one simulated channel. It establishes recovery logic, not audience engagement, subscriptions or revenue. Reserve copy and destinations require initial launch review and live link checks; no individual routine post approval is required after the approved policy is active.

Additional checks: existing social publisher suite reported 66 passed / zero failed; existing masked-presentation suite passed; `git diff --check` passed. The existing social suite can leave background handles alive after printing results; do not interpret its summary as a live account verification.

## Remaining work before production

1. Integrate a transactional persistent outbox with unique slot keys, worker leases and atomic state transitions. The pilot uses injected in-memory state with a serialization restart test; it does not establish crash-safe database behavior or concurrent-worker safety.
2. Connect the existing Buffer adapter with exact ROOK company-channel IDs and appropriate receipt reconciliation. Require authoritative evidence of absence before repeating an uncertain send. Retain daily quotas and independent kill switches.
3. Connect real destination validation, including host allowlists, final URL, HTTP success, canonical and expected content. The pilot uses injected boolean checks.
4. Validate approved publication policy, reserve copy, channel-specific length/media requirements and live account capacity. The reserve must be replenished from substantive reviewed resources as the library expands; no endless paraphrase or duplicate SEO-page generator is included.
5. Integrate actual monthly report generation, website publication and verification before social promotion. This pilot tests social selection/recovery only; it does not publish report pages.
6. Add bounded scheduled dispatch, monitoring for actual delivery, automatic retry/backlog processing and alerts for account reconnection or persistent failures. Nothing has been scheduled.
7. Exercise staging integration and a separately approved controlled live post before enabling recurring publication. Keep pricing, subscriptions, paywall, ingestion and unrelated projects unchanged.

Referral attribution, partner discovery/outreach and payout processing are separate workstreams; this test does not establish that they are implemented or operational. Payment approval remains required.
