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

## Verified production rollout — October 23

PR [96](https://github.com/genoz1/rook-careers/pull/96) merged at source commit `40cbb80c6dfeaf00280ee48adc5df741ec0872f4`. ROOK's existing `seashell-app` deployment `bec107bb-d962-4ee5-a373-2061bfd94d0a` went live at 17:46:52 UTC. Publishing activation configuration `3f20dbd5-a750-4c66-a6f6-61db13e628c5` went live at 18:02:47 UTC. Only `ACQ_PUBLICATION_APPROVED` changed from false to true in that activation save; all other configuration was preserved.

Both approved company Buffer queues are resumed. Their Buffer shortening setting is now No Shortening so ROOK's first-party tracking route is retained; social networks may apply their own display shortening. Legacy resource Facebook/Instagram and industry-news social distribution remain disabled. Partner discovery/email and referral payments remain disabled.

Ten real nonpublic Buffer draft readbacks covered all five categories. Real Facebook image/link-card and LinkedIn image/link-card previews were inspected. Four earlier disposable drafts were deleted after the owner's explicit confirmation, with provider cleanup confirmed. The ten later preview drafts remain unscheduled as a verification record; they are not an automatic send queue. The two older drafts were preserved.

Fresh counts initially disguised repeated opportunity copy and selected a preview asset outside the exported set. The fix strips the count sentence during similarity checks. Preview recovery now reconciles every saved receipt's draft state, company channel, exact text and attachment before continuing; any unresolved attempt, modified draft or published receipt blocks continuation. The combined acquisition/editorial/recovery run passed 55 checks; the final 16 editorial/recovery checks include an additional fresh-count regression. These are overlapping suites, not 71 distinct checks. The changed-file credential scan found no matching credential patterns across 32 files.

All ten public production graphics returned HTTP 200 image/jpeg. Production tracking redirects returned HTTP 302 to the intended existing ROOK landing pages with campaign attribution. All fifteen distinct marketing destinations returned HTTP 200. Home, current login, checkout, pricing, partner signup and private dashboard shell responded; unauthenticated private dashboard data returned HTTP 401. No SQL migration was needed for this revision.

Six unsent/unclaimed acquisition reservations and both remaining future Buffer posts were revised. Existing due times and the two published launch rows were preserved. Missed legacy Buffer posts remain failed and were not retried automatically.

The automatic supervisor run observed at 18:06:50 UTC delivered both revised company posts without a manual supervisor invocation. Exact provider receipts and public pages were confirmed:

- LinkedIn company receipt `6adba227e4be8a4d861ccfe8`, sent 18:06:53.614 UTC: https://www.linkedin.com/feed/update/urn:li:share:7519459346842550272/
- Facebook company receipt `6adba2358b3d437ddc7d7649`, sent 18:06:49.157 UTC: https://www.facebook.com/122102812179462837/posts/122124185703462837

Campaign GA4 traffic/funnel reads and scoped company metrics succeeded. The private report uses Stripe-confirmed subscription data; no conversion lift is inferred from publication. Search Console access remains unavailable. Revenue totals and cancellation evidence are kept in the owner's private report, not this public repository document. The private dashboard requires a verified authorized ROOK login.

Existing subscription terms, checkout implementation, protected job projection, ingestion code and regular job schedules were not changed by this marketing revision. No paid service, advertising, unsolicited outreach or payout was activated.

Buffer references: [public media requirements](https://developers.buffer.com/guides/hosting-media.html), [API reference](https://developers.buffer.com/reference.html).
