# ROOK automated marketing quality revision

The first acquisition post was mechanically correct but read like a database report. This revision replaces report-title captions with reviewed, benefit-led marketing for medical and veterinary sales professionals. Published posts and their engagement history are preserved.

## Editorial and delivery changes

- Thirty reviewed templates span opportunities, practical career advice, membership benefits, interview/resume preparation, and industry insights. An initial twenty-slot rotation implements the requested 30/25/20/15/10 mix. Every template includes a useful call to action and a relevant existing ROOK destination.
- Opportunity counts are drawn only from matching current aggregate cells, never individual job records. Expired or changed facts cause regeneration before sending; an evergreen reserve is available without an AI-generation dependency or additional paid service. Insight templates explain industry research and buying processes without inventing hiring trends.
- Before scheduling or a new send, the worker checks the reviewed template, factual freshness, destination, copy similarity and visual/link presentation. It preserves the existing durable claim, reconciliation, retry and spacing safeguards. Uncertain or accepted sends are reconciled before any new submission.
- Short first-party links carry campaign, content and first-touch attribution after redirection. Known preview bots are excluded from redirect-request counts; requests are explicitly distinguished from human visits and conversions.
- Branded 1200 × 630 graphics reuse the existing ROOK logo. Image posts and explicit platform link cards alternate, using the documented Buffer attachment fields. Images and link attachments are never combined in the same request. Public assets are stable ROOK URLs, checked before a send.
- While the acquisition supervisor is enabled, the older resource and industry-news social distributors defer to it. Article generation/publication continues independently; direct legacy Facebook/Instagram sends cannot bypass the company-only content mix and quality checks.
- Queue revision requires both company queues paused and acquisition publication held. It edits only unsent/unclaimed rows without receipts, backs up queued provider content, preserves provider schedules, and refuses sent/sending or unrelated destinations.

## Subscriber reporting

The private dashboard adds company reach/engagement when the provider supplies it; unavailable or delayed metrics are labeled. Campaign reports distinguish GA4 visits, registrations and checkout starts, redirect requests, and Stripe-verified new active subscribers. Existing customers cannot drive a false acquisition lift. First-touch source/campaign revenue is a contracted monthly run rate, separate from gross cash receipts and browser purchase events.

Automatic mix changes require at least 25 Stripe-confirmed new active subscribers and three comparable categories with at least 100 sessions and three subscribers each. Changes are limited to five percentage points; absent sufficient evidence, the initial mix remains. This is an observational rule, not proof of causation or a revenue guarantee.

## Validation and rollout record

The next ten local generated posts cover all five content categories and render twenty Facebook/LinkedIn layout previews. All twenty image elements loaded at 1200 × 630 without page overflow. Local previews are labeled as approximations; real nonpublic Buffer drafts must be checked separately before queue replacement/resumption.

Seventy focused acquisition/provider checks passed, including persistence/recovery, referral exclusions, canonical Stripe reads and the new editorial rules. Eighteen marketing/company-scope/production-safety checks passed. Subsequent targeted validation covers the final creative preflight. SQL schema, billing routes, price/product objects and ingestion code are unchanged.

Both company Buffer queues and the old automatic social paths were temporarily held for this rollout. Production resume, provider draft readback and queue replacement receipts will be added after verification. Never label this document alone as proof of a deployment or conversion improvement.

Buffer integration references: [public media requirements](https://developers.buffer.com/guides/hosting-media.html), [API reference](https://developers.buffer.com/reference.html). A literal URL in post text does not request a link-preview card; this revision explicitly supplies `metadata.<service>.linkAttachment` or an image asset.


## Actual provider verification, October 23

Production runtime confirmed acquisition publication held and legacy resource Facebook/Instagram and industry-news social distribution disabled. Both approved company Buffer queues remain paused; no public post was created by this verification.

Four nonpublic diagnostic drafts were read back in `draft` state on the exact approved company channel IDs, with matching copy and branded media/card metadata:

- LinkedIn Florida opportunity: `6adb743d10223fea566c7844`.
- Facebook territory advice card: `6adb743d7af932dee4e6df8d`.
- LinkedIn membership benefit image: `6adb743e6fe59a6ed27d42c5`.
- Facebook resume preparation image: `6adb743f6fe59a6ed27d42e3`.

The LinkedIn image preview and Facebook card preview were visually inspected in Buffer. Public preview media is pinned to a reviewed Git commit; production-generated media and short redirects still require deployment verification. The following diagnostic creation did not return a successful receipt; a scoped read of both draft collections confirmed only these four new drafts and the two older drafts. No blind retry occurred.

Automatic review rejected merging before full provider verification, then rejected permanent cleanup of the four disposable drafts without action-time confirmation. Cleanup confirmation is pending. The deployed quality revision, complete ten-post provider check, unpublished queue replacement and publishing resumption are therefore **not completed**. Published history is preserved.

The preview helper now records an in-flight attempt before a mutation and retains returned IDs before validating status. A lost response blocks further creations until reconciliation. Three new recovery/rejection tests plus ten marketing tests passed (13 total).
