# ROOK six-post social replenishment

## Schedule and capacity

Daily America/New_York schedule: 08:30 unmasked Featured Job; 10:00 job-search education; 13:00 rotating industry reflection; 16:00 ROOK value/feature education; 16:30 masked ROOK Match; 19:00 engagement question. The four marketing times preserve the custom schedule observed in Buffer on September 23, 2026. Job slots are additional.

The replenisher targets up to 12 content slots over the next 48 hours. Each intended slot is represented on ROOK LinkedIn and Facebook when capacity permits. Buffer reports `limits.scheduledPosts=10` per channel on the current Free plan; its billing UI confirms the same limit. The worker reads paginated live scheduled/sending posts, preserves occupied slots, counts capacity separately for each channel, and checks again before each mutation. It fills only missing slots chronologically and defers overflow silently until capacity is available. It never upgrades the plan or deletes legitimate content.

Gene's approved personal LinkedIn is an optional downstream destination, not a mirror of the company schedule. It receives the 08:30 Featured Job at 09:15 daily, the 16:30 ROOK Match at 17:15 on Monday and Thursday, and the 10:00 job-search education post at 10:45 on Saturday: ten posts in a complete week. The company refill completes before the Gene phase starts. Missing configuration, capacity, generation, reconciliation or Buffer errors in the Gene phase are isolated and cannot change the company result or fallback state. All personal posts use separately generated personal copy, share the verified deterministic facts/artwork/link from the company source, and use the same live capacity checks, durable send ledger and recovery protections.

## Fresh copy and facts

ROOK's own `OPENAI_API_KEY` calls the Responses API. Model: `SOCIAL_OPENAI_MODEL` or `gpt-4o-mini`. Existing company LinkedIn, Facebook and Reddit generation is unchanged. A separate personal LinkedIn call is made only when a selected Gene slot has a prepared company source, available Buffer capacity and no existing scheduled post. Gene's queued/sent copy and the source company post are supplied as recent-copy context; normalized word-stem overlap rejects substantially repeated wording. Personal generation has no fallback into or effect on company generation. This is a bounded similarity heuristic, not a guarantee against every semantic paraphrase.

Free-form copy is restricted to original questions and reflection prompts with no names, numbers, URLs, testimonials, market assertions or product promises. Industry labels, real job facts, employer disclosure, links and product CTA are inserted by deterministic code. Job copy receives approved category context only; employer details never go to the model. Marketing is deliberately conservative rather than inventing trends or statistics. Three unsuccessful generation attempts trigger deterministic fallback and owner escalation. No recurring Work/Codex session is used.

Existing active-job checks, top-100-city preference, employer/geography rotation, masked title/hook sanitization and permanent job fingerprint deduplication are retained. Jobs expiring before their future slot are excluded and jobs are rechecked after rendering before enqueueing. The migration adds only the package's service-role-only send ledger, refill lock and lease function.

## Recovery and attribution

A durable intent precedes each Buffer mutation. Explicit rejections can retry up to three times; ambiguous sends are reconciled against live channel/time/copy, including shortened-link normalization, without blindly resending. Unmatched uncertainty stops refill and alerts. Partial job runs retain their selected job; successful channels remain recorded. Normal full-capacity deferrals are not incidents.

Resend sends `URGENT — ROOK: Social queue needs attention` to `gzentko@gmail.com` after unresolved recovery or OpenAI exhaustion. Stable daily idempotency keys suppress repeated sends. Resend failure leaves a nonzero dispatch exit for platform monitoring. The existing scheduler must remain healthy; this is not a whole-platform outage monitor.

Links preserve `utm_source=linkedin` or `facebook`, `utm_medium=social`, `utm_campaign=organic`; regular content also has deterministic `utm_content`. Reddit-formatted copy/link support exists for future controlled use but no Reddit community is posted to. Google Ads, GA4, Google attribution and spend remain unchanged. Personalized job emails and matching are unchanged.

Queued job closures after enqueueing are not automatically cancelled: the original package contained no cancellation implementation. Missing or incompatible saved receipts require reconciliation rather than automatic duplicate publication. No new analytics or cancellation infrastructure was introduced.

## Deploy and operate

Apply `backend/db/social-queue.sql` before code activation. Keep the existing DigitalOcean `job-posts` command `node backend/socialPublishWorker.js scheduled-dispatch` and its existing AM/PM replenishment triggers. These triggers refill ahead; actual posting follows the six future due times. A controlled first dispatch seeds available capacity. Do not run a competing Work-driven publisher. Existing manual posts are preserved/adopted by channel and due time.

Reused environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SOCIAL_SPACING_HMAC_SECRET`, `BUFFER_ACCESS_TOKEN`, `BUFFER_ROOK_LINKEDIN_CHANNEL_ID`, `BUFFER_ROOK_FACEBOOK_CHANNEL_ID`, `SOCIAL_AUTOMATION_ENABLED`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `DIGEST_FROM_EMAIL`. Optional `BUFFER_GENE_LINKEDIN_CHANNEL_ID` identifies Gene's existing connected Buffer destination; it is not a new credential, and an invalid or missing value disables only Gene's downstream phase. Other optional variables: `SOCIAL_FRESHNESS_WINDOW_DAYS`, `SOCIAL_BRANDED_TERMS`, `SOCIAL_OPENAI_MODEL`. `SOCIAL_AUTOMATION_ENABLED=false` pauses refill; it does not cancel already queued Buffer posts.

An isolated OpenAI validation fallback is written to the job log with its slot, model, and final validation reason, but it is not an urgent incident when deterministic copy was queued successfully. API unavailability, uncertain sends, and company-pipeline failures still trigger the urgent alert. Normal Buffer capacity deferrals remain non-failures.

## Weekly owner report hook

Weekly growth reporting remains disabled pending an existing trustworthy aggregate source. Future integration may use existing Resend with a week-specific idempotency key for visitors, onboarding starts, email captures, trials, paid conversions, source, social metrics and ad spend only where those real values exist. No missing metrics are invented; no tracking warehouse, payment change or new analytics system was added.

## Focused tests

Run `node backend/testSocialAutomation.js`, `node backend/testSocialPublishWorker.js`, `node backend/testSocialScheduler.js`, and `node --test backend/testSocialCityPreference.js backend/testSocialWorkerExit.js backend/testSocialQueue.js`. No unrelated full suite is required.
