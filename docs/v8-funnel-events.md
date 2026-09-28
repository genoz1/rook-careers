# V8 funnel event meanings

These are browser events, so ad blockers, navigation, and unavailable storage can cause undercounting. Count unique visitors or account IDs in the appropriate system; event counts alone are not unique accounts. The V8 search request ID is a random UUID for matching a failure event to a sanitized server log, not a user identifier. Timing values are rounded to 500 ms and capped at two minutes.

| Event | Fires when | Proves | Does not prove |
| --- | --- | --- | --- |
| `v8_dashboard_impression` | V8 script initializes | Landing script ran | Overlay or results rendered |
| `v8_overlay_displayed`, `v8_location_step_viewed`, `v8_industry_step_viewed` | Initial overlay shown | Both fields were presented | Visitor interacted with either field |
| `v8_location_completed` | Visitor selects a location suggestion | Valid location selected | Search submitted; ZIP is never sent to GA4 |
| `v8_industry_selected` | Visitor changes the industry select | Industry selected | Search submitted |
| `v8_show_my_jobs_requested` | Valid form submission, before auth lookup or network | Visitor attempted initial search | Server received or completed request |
| `v8_initial_search_succeeded` | POST `/api/v8/session` returned success | Initial server search responded; `elapsed_bucket_ms` is request-to-response | Preview rendered |
| `v8_initial_search_failed` | Initial POST/auth/network attempt throws | Search attempt failed; category, HTTP status, request ID, and rounded elapsed time assist diagnosis | Server necessarily received request |
| `v8_overlay_submitted` | Token stored after successful POST | Historical successful submit milestone | Click alone or render |
| `v8_preview_results_received` | Valid preview data available | Browser has usable data | Cards painted |
| `v8_preview_dashboard_displayed` | Results inserted into DOM | Usable preview built | Browser completed paint |
| `v8_preview_results_rendered` | Two animation frames after DOM update | Browser reached a paint opportunity; `elapsed_bucket_ms` is request-to-render | Visitor viewed or read a card |
| `v8_preview_results_failed` | POST succeeded, then preview handling throws | Preview stage failed | Initial search failed |
| `v8_two_job_reveal_viewed` | Preview containing revealed jobs built | Reveal shown in preview | Jobs clicked |
| `v8_masked_unlock_interaction` | Unlock CTA or masked card clicked | Unlock intent | Signup loaded |
| `v8_signup_reached` | Browser navigation to signup attempted | Navigation intent | Signup loaded |
| `v8_signup_started` | Signup script initializes for a visitor without an existing authenticated redirect | Signup page initialized | Account created |
| `sign_up`, `v8_account_created` | Verified user and profile claim succeed | One GA4 account creation and a parallel V8/Meta milestone per browser account | Trial or subscription activated; GA4 account-level routing still requires live verification |
| `checkout_started`, `v8_checkout_page_loaded` | Authenticated checkout page initializes | Checkout reached | Stripe form ready or submitted |
| `v8_checkout_started` | Stripe form ready after account preparation | Checkout can proceed | Card submitted |
| `v8_checkout_submitted` | Visitor clicks enabled payment button | Checkout attempt | Stripe succeeds |
| `trial_activated`, `v8_trial_started` | Confirmed `trialing` profile observed on return | Trial activation observed | Paid charge; V8 and dashboard return paths share a session guard |

Attribution: `rook-attribution.js` stores first-touch UTM fields or inferred Google CPC source from Google click IDs in localStorage. V8 POST copies those fields to the preview profile, and `/claim` carries them to `candidate_profiles`; Stripe can read those profile fields later. Raw click IDs are not stored in profile or sent as event parameters. GA4's own browser attribution depends on its tag configuration and cross-page cookie state, which must be checked in the live property.
