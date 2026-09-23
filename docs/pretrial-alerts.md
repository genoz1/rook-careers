# Optional pre-trial job alerts

Flow: existing onboarding → optional email → existing masked dashboard → existing signup/trial. Skip and Escape immediately continue. Submission saves an explicit `job_matches_v1` request, existing search profile, source and timestamp. Signup prefills the submitted email. Account verification and checkout remain required for full access.

Desktop visitors who skipped, have viewed matches for at least 10 seconds and move the pointer out through the top edge may see one optional second offer. No mobile prompt, navigation interception or repeated exit offer. Existing auth sessions, captured visitors and trial/signup clicks suppress the offer.

The existing `send-digest` command also processes pre-trial leads through V7 ranking and the exact masked dashboard projection. Only jobs first seen after consent, within seven days, scoring at least 60 are sent; maximum five per message. No old-job fallback. Durable per-lead/job reservations prevent concurrent or repeated sends. Ambiguous/failed sends remain reserved rather than risk duplicates; this can omit an alert after a delivery failure. Resend delivery and provider suppression remain unchanged.

A normalized email is unique. Unverified email submissions never overwrite an existing lead's criteria, re-enable opt-outs, modify existing accounts, or create accounts. Existing accounts/profiles are excluded from this anonymous mailing path. A converted lead stops receiving pre-trial alerts; the existing account email system handles it. Duplicate submissions receive the same non-identifying response. The anonymous session can capture once, atomically. The new unsubscribe link disables the lead, using an opaque token and a POST confirmation so link scanners cannot change preferences. No unrelated marketing subscription is created.

Returning leads retain the existing session-based masked dashboard experience. The email link contains no session credential. A new browser/tab or expired session requires restarting search through the dashboard's existing Start again link; cross-device identity recovery is deliberately not added. Duplicate emails keep the original search criteria until account verification, rather than let an unverified submission change someone else's preferences.

Analytics reuse `rookTrackFunnelEvent` and Google tags. Existing events: `v7_questions_completed`, `v7_masked_dashboard_viewed`, `v7_trial_activated`. Added: `pretrial_email_prompt_viewed`, `pretrial_email_captured`, `pretrial_email_skipped`, `pretrial_exit_email_prompt_viewed`, `pretrial_exit_email_captured`, `pretrial_exit_email_dismissed`, `pretrial_job_email_returned`. Capture events mean an accepted request, not a newly created lead (duplicates/account exclusions are intentionally indistinguishable). No emails or criteria are sent to analytics. Cross-device lead-to-trial attribution and email returns without a retained session are not reliable; no new identity analytics system was added.

## Deployment

1. Apply `backend/db/pretrial-alerts.sql` in the existing Supabase project. It adds two private service-role-only tables, one session boolean and two service-role-only functions. Existing tables, jobs and entitlements are unchanged otherwise.
2. Deploy the commit to the current DigitalOcean app source (`genoz1/rook-careers`, `main`). Reuse the existing Supabase, Resend, `DIGEST_FROM_EMAIL` and `PUBLIC_APP_URL` settings; no new secret/configuration is needed. Confirm the existing `npm run send-digest` schedule runs; do not invoke it manually against all real recipients for testing.
3. One private/new visitor acceptance: onboarding → optional email → Skip for now → masked dashboard → existing trial CTA. Do not purchase.
4. Check capture with a controlled rollback transaction or existing appropriate account exclusion, without sending messages or creating a disposable live lead. Confirm the deployed capture route and unsubscribe endpoint.
5. Stop after acceptance.

## Validation completed locally

- Seven new focused tests: `node --test backend/testPretrialAlerts.js backend/testPretrialAlertRoutes.js`.
- Five existing security tests: `node --test backend/testPretrialSecurity.js`.
- Existing actual pretrial routes, digest location, email-code flow and 57 trial-flow checks passed.
- Migration executed in temporary PostgreSQL-compatible PGlite: criteria/consent, duplicate immutability, opt-out preservation, existing account exclusion, conversion exclusion, invalid session and anonymous table/function denial passed.
- JavaScript syntax and whitespace checks passed.
- No ingestion, social automation, matching algorithm, prices, payment or global masking files changed.

Deployment and production browser acceptance are pending browser-control reconnection. No production migration, leads, emails or purchases have been created by this task.
