# Onboarding V7

V7 is isolated from V6. Entry: `/rook-onboarding-v7.html`.

Four existing questions → analyzing → existing dashboard layout with real,
server-masked matches and the optional Upload/Skip popup → Unlock My Matches
or Unlock Job → current V6 signup/email-code verification → existing Stripe
card checkout → same result snapshot, unmasked only with server-confirmed access.

The signup and checkout HTML are copies of the current implementations; only
V7 state transfer, analytics and return routing differ. Existing V6 files,
Stripe backend, matching engine, and résumé parser/analysis/upload route are
unchanged. V7 ranking uses the existing anonymous query and scoring path,
expanded to the dashboard's 300-row display cap. There is no preview page.

Before deploying, run `backend/db/onboarding-v7.sql` in the existing Supabase
project. It creates one RLS-protected table and one private bucket, available
only to the server service role. It changes no existing table or policy.
No new environment variables or payment products are needed.

Anonymous answers and the result snapshot expire after 24 hours. The browser
stores only a random capability token in sessionStorage; no résumé contents
are stored in localStorage or sessionStorage. Anonymous résumé files are
staged privately, atomically bound to one verified account, downloaded only
by that account, and submitted to the unchanged `/api/resume` processing
route. After success the staged file is removed. Expired session files and
rows are removed hourly while the server runs. Expiration is enforced on
requests even while cleanup is delayed. Active account data persists in the
existing candidate profile.

Skipping the popup dismisses it only for the current masked/unmasked stage.
An uploaded résumé suppresses the second popup. Payment cancellation or
failed activation leaves the snapshot masked. A reload during résumé transfer
can retry through checkout. The checkout callback is not an entitlement.

Focused validation: `node backend/testOnboardingV7.js`, plus the existing
V6 email-code and trial-flow tests. The V7 test uses fake external services;
live Supabase RLS/storage and Stripe/email behavior require staging validation
with the migration applied and provider test credentials. Never use a real
card to run an automated validation.

Validation completed locally: V7 route/security tests passed; V6 email-code
checks passed; all 59 existing trial-flow checks passed. A headless browser
completed both Upload and Skip flows from the four questions through email
verification and simulated card activation, including the correct second-popup
behavior. Browser validation uses simulated provider responses, not live
Supabase/Stripe. To repeat with Playwright installed, run
`node backend/testOnboardingV7Browser.js`; optionally set
`ROOK_PLAYWRIGHT_MODULE` and `ROOK_CHROME_PATH` for an external installation.
