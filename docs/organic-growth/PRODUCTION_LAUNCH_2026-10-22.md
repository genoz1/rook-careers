# ROOK production launch record — October 22, 2026

The owner explicitly authorized merge, deployment and conservative company-page publishing. Personal LinkedIn, paid advertising, changes to checkout/billing/subscriptions/job ingestion, new recurring costs and commission payments remain prohibited.

## Verified before deployment

- Fetched `codex/organic-growth-oct2026` at `fc3ad5efd59c93c079bb51613197c92eb50f928d`; production main was `7b8aaf0f4100fa28c05fe523ecc20270a9b4f76b`.
- Existing ROOK production Supabase physical backup: October 22, 13:40:42 UTC. Reviewed additive acquisition schema applied transactionally with a five-second lock timeout and 30-second statement timeout. Five new acquisition tables exist, all with RLS enabled. No existing job/customer/billing table was changed. Anonymous/authenticated RPC execution remains revoked.
- Actual Stripe sandbox account authenticated from the ROOK console. Embedded Postgres validation exceeded that console process's resources before a transaction result. Validation was moved to an isolated local process using the same existing sandbox credential in memory; no credential file was created.
- Real sandbox subscription payment produced exactly one $5 referral commission. Duplicate events did not duplicate it. Actual sandbox refund reversed it. Actual sandbox cancellation excluded the subscriber from active metrics. SDK signature validation accepted the valid payload and rejected a tampered payload. All disposable fixtures cleaned up: subscription canceled, customer deleted, price/product archived. Remote webhook delivery is a separate gate.
- Existing live Stripe connection and existing subscription objects were unchanged. The $29 subscription remains outside the 51-subscriber target.
- Prior Buffer draft create/read/delete and Resend simulator delivery evidence remain valid. Neither establishes a production public post or inbound webhook delivery.

## Additional protections

- Personal LinkedIn cannot be enabled by legacy environment flags; the personal Buffer connection remains disconnected.
- Legacy job-card automation is disabled in loaded configuration because it could reveal protected listing facts. The acquisition sidecar uses reviewed aggregate/evergreen content instead.
- Startup coordinate repair requires a separate explicit maintenance opt-in; ordinary deploys cannot run that repair against job records.
- Acquisition configuration failures disable that sidecar and leave existing customer service available; startup logs contain no underlying credential-bearing exception.
- Existing GA4 service-account configuration can be reused without creating a new account or duplicating a secret.
- Focused verification: 34 queue/startup checks, 66 legacy publisher checks, then five final production-safety checks passed. Tests involving the final guards were rerun as needed. Previously completed acquisition/SEO/hosted/browser checks were retained without wholesale reruns.

## Rollback and ongoing cost

Disable `ROOK_ACQUISITION_ENABLED` or individual acquisition approval flags to stop the sidecar, and revert the launch merge if needed. Preserve acquisition accounting tables and receipts during rollback; do not drop ledgers or restore the whole production database for a sidecar failure. Existing checkout, Stripe webhook and ingestion remain independently configured.

The prior temporary Supabase preview was deleted with owner confirmation, removing its $0.01344/hour compute cost. Existing provider plans continue. No new service, paid advertising or payout adapter was enabled by these checks. Ordinary provider quotas and payment-processing fees still apply.

## Activation evidence

Production deployment, scheduler, company publications, referrals, remote webhooks, analytics and monitoring must each be verified after activation. This record does not label those operations complete merely because code or local tests pass.

## Hosting behavior discovered during activation

PR #91 merged at `222ce2e182a29052cbd9a2a967065fe3fac32391`. A configuration-only deployment reused the prior application source; acquisition code was not yet live. DigitalOcean also ran its pre-existing Adzuna post-deployment hook. The provider log reports 1,590 results examined, 112 agency-filter matches and 96 records saved/updated. This was an unintended deployment side effect; no attempt was made to undo those records or restore the database.

The owner then explicitly authorized making deployment-only work manual while preserving regular schedules. There is one post-deployment ingestion hook, `ingest-adzuna`; its command now prints a pause notice. Its original manual command is `npm run ingest-adzuna`, requiring separate authorization before execution. The five scheduled jobs, their commands, schedules, resource sizes and time zones were preserved exactly. The hook pause and an encrypted, separate acquisition Stripe signing secret were applied together. The original checkout endpoint remains unchanged. The new acquisition endpoint is disabled until its runtime is configured and verified.

Resend dashboard access was restored using the owner-confirmed existing Google account. The email webhook now rejects unrelated sender/recipient events before any ROOK database access, restricts bounce/complaint suppression to tracked partner receipts, and records only type/time/event hash for delivery diagnostics. Six focused HTTP/signature/scope checks passed. Provider acceptance, signed event receipt and confirmed delivery remain distinct. GA4 reporting now also queries the existing registration/checkout/browser-conversion events by source/medium, without treating browser purchase events as Stripe payment evidence.

## First real production cycle

Latest acquisition source was deployed through DigitalOcean's explicit Deploy action; configuration-only deployments had reused old source. Public partner/report routes returned 200; private dashboard shell returned 200 with no-store/noindex, and anonymous private API access returned 401. Production baseline completed with five historical monthly payers excluded. A read-only production Stripe reconciliation confirmed three active full-price subscribers and 5,997 cents MRR; the separate $29 subscription is excluded. Existing GA4 authorization returned 44 channel rows and 32 funnel-event rows. The configured Search Console domain property denied access or quota; access is not claimed.

The cycle correctly withheld all reports because collection capture began after its fixed cycle-start validation timestamp. A focused fix validates new snapshots against collection completion time, uses a fresh clock for publication/reserve validation, and refuses genuinely future-dated snapshots/cache entries. Three targeted regression checks cover the actual worker functions, including four report records after a delayed collection. Automated publication remains disabled until post-fix production verification.
