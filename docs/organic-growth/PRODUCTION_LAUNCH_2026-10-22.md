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
