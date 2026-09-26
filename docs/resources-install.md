# ROOK Career Resources — installation and activation

## Scope and source

Public `/resources/`, `/resources/category/:category/`, `/resources/:slug/` use the approved desktop/mobile composition. Reusable photography is extracted from the supplied approved mockup; thumbnails are consequently limited by its original resolution. No new paid article images are generated. Images rotate within each category. Existing ROOK logos, fonts, job preview filtering and funnel destinations are reused.

Florida Buzz reuse: `lib/aiText.js` supplies the Responses API research/structured-output/retry boundary, adapted in `backend/resources/aiText.js`. Its `scripts/generate-guide.js` provides the research → validation → storage pattern. Its Facebook photo posting and Instagram container/status/publish flow inform `meta.js`, with separate ROOK variables and durable send receipts. ROOK's existing Buffer queue, locking, receipts, media checks, real capacity checks, and job slots remain in use. No direct LinkedIn API is introduced.

## Install

1. Apply `backend/db/resources.sql` to the ROOK Supabase database. This is additive and service-role-only; it does not change job or user policies. The existing `backend/db/social-queue.sql` is also required for the existing Buffer worker. Never reinitialize production tables.
2. Deploy code with all Resources enable flags absent or `false`.
3. Run `npm run resources:seed` in the ROOK service. This inserts 210 curated topics without resetting existing topic states.
4. Verify `/resources/`, categories, logged-out article access, dashboard links, and `/resources/sitemap.xml`. The independent sitemap is advertised in `robots.txt`; existing job sitemap/schema logic is unchanged.
5. Run `node backend/resources/worker.js publish-one --confirm-publish` after 9 AM America/New_York. It consumes one of today's persistent slots and leaves daily automatic publishing off. Inspect the resulting article. Run `node backend/resources/worker.js verify` if deployment availability delayed verification.
6. Run `npm run resources:meta-check` from DigitalOcean. It only reads identity/linkage/permissions and never posts. Missing or mismatched credentials fail closed. Advertising credentials alone are not Page publishing credentials.
7. With verified ROOK-specific credentials, run one controlled post per channel: `node backend/resources/meta.js test facebook SLUG --confirm-post` and the equivalent `instagram` command. Receipts are retained. No automatic retry of ambiguous publication.
8. Enable `RESOURCES_BUFFER_ENABLED=true` on the existing social worker and test `social:scheduled-dispatch`. Verify ROOK LinkedIn and Gene's distinct personal LinkedIn channel receipts and preserve the two daily job posts and all existing queued posts. Articles take the two existing marketing slots rather than increasing company posting volume. Existing posts are never wiped. An already-filled rolling queue can delay the first article social post.
9. After controlled checks pass, set `RESOURCES_AUTOPUBLISH_ENABLED=true` on the web service. The scheduler runs every five minutes, publishing at 9 AM and 3 PM America/New_York by default. Set `ARTICLES_PER_DAY=2` (1–12 supported; evenly spaced across twelve hours). Changing quantity mid-day does not move existing persistent slots. No backfill of missed prior days; same-day missed slots catch up. Invalid articles get one regeneration, then rejection and a replacement topic; at most three topics per tick and six claims per slot. Exhausted slots fail visibly instead of publishing bad content.

## Configuration

Reuse existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `PUBLIC_APP_URL` (defaults to `https://rookcareers.com`). Never copy Florida Buzz secrets. `RESOURCES_AI_MODEL` optionally overrides the inherited Florida Buzz text model; no changes to ROOK's existing AI clients.

Defaults are OFF: `RESOURCES_AUTOPUBLISH_ENABLED`, `RESOURCES_BUFFER_ENABLED`. Meta distribution also requires `ROOK_META_ACCESS_TOKEN`; no token means no Meta requests. Per-channel flags can explicitly disable either Meta destination.

Existing Buffer credentials: `BUFFER_ACCESS_TOKEN`, `BUFFER_ROOK_LINKEDIN_CHANNEL_ID`, `BUFFER_ROOK_FACEBOOK_CHANNEL_ID`, and `BUFFER_GENE_LINKEDIN_CHANNEL_ID`. Gene's profile must be a distinct LinkedIn channel in the same organization. The existing Buffer job consumes its existing configuration; set flags on that worker as well as on the web service when appropriate.

Direct Meta needs one new secret: `ROOK_META_ACCESS_TOKEN`. Use a long-lived **Meta user access token** with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, and `instagram_content_publish`, authorized for the ROOK Page and its linked Instagram professional account. It is not an OpenAI key or the ad account ID. The code obtains the corresponding Page token internally without logging it, finds exactly one ROOK Page, and uses its linked Instagram account. Optional `ROOK_FB_PAGE_ID` / `ROOK_INSTAGRAM_USER_ID` pin exact account identities if needed; they are not required when discovery is unambiguous. Optional `ROOK_META_GRAPH_VERSION` overrides `v24.0`.

No credential is embedded in the files. The current `META_ADS_ACCESS_TOKEN` was checked read-only: its permissions are only `ads_management`, `ads_read`, `public_profile`, and `/me/accounts` returns an empty list. Leave it unchanged for ads.

When the new token is present, the enabled Resources worker attempts direct distribution; explicitly setting `RESOURCES_FACEBOOK_ENABLED=false` or `RESOURCES_INSTAGRAM_ENABLED=false` keeps that channel off. Run the non-publishing preflight and controlled tests before adding the token to the continuously running worker. Existing Buffer Facebook articles already recorded as sent are not sent again. Buffer is kept connected: direct Facebook article preference requires successful Meta receipts for both channels; an individual accepted or ambiguous Facebook mutation is never duplicated through Buffer. Existing Facebook job posts stay in Buffer. No automated account disconnection or alteration to the two daily job posts.

Gene's existing Buffer LinkedIn connection was verified as `gene-zentko`. With Resources integration enabled, the queue can discover that exact unique LinkedIn profile if the worker has no configured personal channel ID. Explicit `BUFFER_GENE_LINKEDIN_CHANNEL_ID` continues to take precedence. Corporate and personal copy differ.

## Reliability and safety

Generation uses database leases plus owner fencing, atomic article/slot/outbox publication, unique slugs/titles/body hashes, source requirements, HTML checks, duplicate/repetition checks and editorial validation. These are safeguards, not a guarantee that AI cannot make factual errors; review the controlled article and monitor early output. Article bodies are not published if quality validation fails. News is never automatically fabricated: Industry News is a public category but has no automatic generation queue. Adding sourced news requires editorial approval and a separate publication workflow.

An article must return its own public HTML before distribution. Social errors do not remove articles. Buffer ambiguous sends use the existing reconciliation ledger. Meta `sending`/`uncertain` rows require checking the provider receipt/recent media before manually deciding whether retry is safe; never reset them blindly. Worker leases expire after 30 minutes, and a replacement worker fences stale writers.

Check `npm run resources:status` and the existing social scheduler status. Topics, slots and distribution records retain progress across restarts. Disable feature flags for rollback; revert the code commit if needed, leaving tables/content intact. No secret changes are required to roll back.

## Tests and analytics

`npm run test-resources` tests the real PostgreSQL migration with embedded PGlite, leases/restarts, idempotency, RLS permissions, public route rendering, metadata escaping, validation, URL verification failures, scheduler disable behavior and Meta identity refusal. Run the existing `node backend/testSocialQueue.js`, `node backend/testSocialScheduler.js`, and `node --test backend/testPublicIndexing.js backend/testPretrialSecurity.js` for integration regressions.

Browser verification: desktop and mobile index, categories, article, navigation and job CTAs. Article fixture content is for local visual testing only; never publish fixture prose.

Analytics reuse the existing Google IDs and attribution script. Events: `resource_article_view`, `resource_job_click`, `resource_find_matches_click`, `resource_signup_start`, `resource_trial_start`. Original resource slug is stored in session storage and attached to resource funnel events; existing campaign attribution and subscription logic remain unchanged.
