# Ad Manager GA4 reporting

## Production configuration and live validation

The repository configures measurement ID `G-LDG2CL5Z8R`. The owner has confirmed that DigitalOcean production now has `GA4_PROPERTY_ID=552914293` and encrypted `GA4_SERVICE_ACCOUNT_JSON`, that the Analytics Data API is enabled, and that the service account has Viewer access. The environment-variable deployment is live. No private-key value was accessed, printed, logged, downloaded or modified during this task.

The candidate reporting endpoint is not deployed yet, so live totals and attribution cannot be verified until the owner deploys this PR. Do not retrieve the production private key for local testing.

After deployment, use the existing authenticated Ad Manager session at `/rook-admanager.html` and select Today, Yesterday and 7 Days. The page calls `/api/admin/admanager/ga4?period=<period>` using the existing Ad Manager access mechanism. Verify property `552914293`, returned property timezone and date range, users/sessions/new users, every reported V8 stage, raw `sign_up`, source/medium and campaign rows. Compare against GA4 using identical dates, `totalUsers` (not active users), session attribution and event counts. Record absent rows, thresholds, recent-data delay and differing ad-account timezones. Do not put authentication tokens in screenshots or reports. No additional production environment change is expected based on the owner's setup confirmation.

The existing Google Ads refresh token is not assumed to have Analytics scopes. No existing credentials or tracking events are changed. No new package dependency is needed.

## Definitions and limitations

- Users = `totalUsers`, alongside `sessions` and `newUsers`, queried without dimensions to avoid summing overlapping users.
- Verified source event names used: `v8_dashboard_impression` (V8 landing/dashboard impression), `v8_show_my_jobs_requested` (search request), `v8_signup_started` (signup page reached), `v8_account_created`, `v8_checkout_started`, `v8_trial_started`, and the original `sign_up` event count.
- Existing generic `checkout_started`, `trial_activated`, V7 events and other V8 interaction events are deliberately not added together with these events; that would overlap stages. All their implementations remain unchanged.
- These browser events are observable proxies, not confirmed billing records. No reliable GA4 paid-subscription/purchase emission was found. Trial activation is not a paid conversion.
- `sign_up` is displayed uncorrected with the requested duplicate warning. The cause has not been investigated or changed.
- Stage ratios use unique users per event divided by unique users at the previous available stage. These are independent period totals, not an ordered/cohort funnel. Ratios may exceed 100%; no sequential conversion rate is claimed.
- An absent event row is displayed as no data returned. It is not converted to zero, because an absent row cannot prove whether an event was received or suppressed.
- Attribution uses native `sessionSourceMedium` and `sessionCampaignName`, with separate event counts by those same dimensions. Values are shown verbatim, including unknown/unset values; sources are not guessed. Live attribution remains unverified pending access.
- First-touch UTMs are stored by ROOK and included as custom event context, but this does not establish a reliable mapping to platform campaign IDs. Campaign names alone are not sufficient. Ad rows stay unchanged; no cost per signup/trial/visitor is calculated.
- Today/yesterday/last 7 days follow the GA4 property timezone. Last 7 days includes today plus the previous six days. Ads continue using their existing account timezones; calendar boundaries can differ. Recent GA4 data can lag.
- Top 100 source/campaign traffic rows and top 1,000 attributed event rows are shown; truncation is explicitly warned. Privacy thresholds, sampling and `(other)` aggregation also produce warnings.
- Four reports use one batch call with a 60-second server cache per period and shared in-flight requests. OAuth tokens are cached server-side. Provider calls time out after 12 seconds. GA4 loads separately from ad reporting.

## Validation completed

Passed `node backend/admanager/testGa4.js`, `testGa4Ui.js`, `testGa4Route.js`, `testOverviewUi.js`, `testDashboardRequest.js`, `testReporting.js`, `testPortfolio.js`, `testPreviewJobs.js`, `testPreviewReporting.js`, and `test.js` (40 existing policy/client tests). These are simulated API/DOM tests, not live provider tests. Covered all periods, totals, attribution, missing data, ratios and zero denominators, escaping, cache reuse, request failures, stale results, Google/Meta reporting, campaign sorting, and budget behavior. `git diff --check` passed.

Desktop and mobile validation completed in Chrome with simulated responses at 320, 375, 390, 430, 768 and 1280 pixels. No page-level horizontal overflow was observed. Full-page phone and desktop screenshots were inspected. Verified date controls and the source/campaign event disclosure; simulated GA4 API failure left Google/Meta totals and campaign rows visible. GA4 route tests also verify authentication rejection, period validation and `Cache-Control: no-store`. Unexpected provider errors are replaced with a fixed safe message, and a test confirms provider details are not returned.

Live GA4/Google/Meta comparisons remain pending deployment and authenticated access; simulated numbers are not production evidence. The existing responsive campaign layout and all analytics event implementations are unchanged.

## Release

Publish only the feature branch and PR. The owner must merge the reviewed PR into `main` and deploy that merged revision through DigitalOcean. If DigitalOcean auto-deploys `main`, merging may itself trigger deployment; the agent has neither merged nor deployed. Existing encrypted GA4 variables should remain unchanged. After the owner confirms deployment, validate the authenticated production endpoint as described above.

Changed production files: `public/rook-admanager.html`, `backend/routes/admin.js`, `backend/admanager/ga4.js`. Additional files are this setup note and three GA4 test files. No package manifest, lockfile, ad client, tracking event, onboarding or checkout implementation is changed.

References: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema and https://developers.google.com/analytics/devguides/reporting/data/v1/basics
