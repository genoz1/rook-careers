# ROOK Careers — Prototype + Live Backend Wiring

A job-matching platform prototype for medical and veterinary sales
professionals. The UI is fully built, and the **login/signup, résumé
upload, and dashboard job feed are now wired to real backend API calls**
— they just need your real Supabase/Stripe credentials (see
`ROOK-Setup-Guide.pdf`) to actually work end to end. Everything else
(match scoring, most of the onboarding fields, tailored résumés) is
still sample data — see "What's deliberately NOT here yet" below for
the precise line.

The full technical architecture for the real backend (job ingestion from
Greenhouse/Lever/Ashby, the matching engine, database schema, etc.) is
written up separately in `ROOK-Technical-Architecture-Spec.docx` — that's
the spec to hand to Claude Code for the remaining Phase 1.5 work.

## What's in here

```
rook-project/
├── server.js                      # Express app — serves the frontend + wires backend routes
├── package.json
├── .env.example                   # copy to .env and fill in — see ROOK-Setup-Guide.pdf
├── .gitignore
├── ROOK-Setup-Guide.pdf           # step-by-step account setup (Supabase, Stripe, AI, job sources)
├── ROOK-Technical-Architecture-Spec.docx   # the full backend architecture plan
├── backend/
│   ├── db/schema.sql              # Postgres schema — run this in Supabase's SQL editor
│   ├── ingest.js                  # pulls jobs from Greenhouse/Lever/Ashby into the database
│   ├── adapters/                  # one file per job source (greenhouse.js, lever.js, ashby.js)
│   └── routes/                    # Express API routes (profile.js, jobs.js, stripe.js)
└── public/
    ├── assets/                       # NEW — official ROOK brand assets
    │   ├── favicon.ico, favicon-16/32.png       # browser tab icon
    │   ├── rook-icon-96/180/192/512.png         # standalone R/rook mark, various sizes
    │   ├── rook-full-logo-480/900.png           # full lockup w/ tagline, for footers
    │   ├── rook-social-share.png                # 1200px wide, for social cards
    │   └── *-source.png                          # original supplied files, full-res
    ├── index.html                    # homepage
    ├── rook-login.html               # log in / create account (Supabase Auth)
    ├── rook-config.js                # put your Supabase URL + anon key here
    ├── rook-auth.js                  # shared auth helpers used by wired pages
    ├── rook-onboarding.html          # 7-step signup flow — résumé upload + profile save are LIVE
    ├── rook-dashboard.html           # dashboard — fetches real jobs from /api/jobs when signed in
    ├── rook-search.html              # job search / filterable results (still sample data)
    ├── rook-job-analysis.html        # single job match breakdown (still sample data)
    ├── rook-application-package.html # tailored resume / cover letter / etc. (still sample data)
    ├── rook-tracker.html             # application tracker (still sample data)
    ├── rook-saved.html               # saved jobs + compare (still sample data)
    ├── rook-intelligence.html        # career intelligence / strengths (still sample data)
    ├── rook-settings.html            # account settings (still sample data)
    ├── rook-pricing.html             # pricing + 30-day match guarantee
    ├── rook-about.html                # about page
    └── rook-employers.html           # for-employers landing page
```

**Before any of the live wiring works**, fill in `public/rook-config.js`
with your real Supabase project URL and anon key (see
`ROOK-Setup-Guide.pdf`, Section 1.4). Until you do, `rook-login.html`
shows a visible warning instead of failing silently.

### What's actually wired now

- **`rook-login.html`** — real Supabase Auth sign-up and sign-in (email/password)
- **`rook-onboarding.html`** — the résumé file upload on Step 1 calls
  `POST /api/resume` for real; the final "Start Finding My Jobs" button
  on Step 7 saves the Basic Info and Preferences fields via
  `PUT /api/profile`, then redirects to the dashboard
- **`rook-dashboard.html`** — requires a signed-in session (redirects to
  login if not), then calls `GET /api/jobs`. If real jobs exist in your
  database, they replace the sample cards (without match scores, since
  the matching engine isn't built yet). If not, the sample cards stay,
  with a banner explaining why

Onboarding Steps 2–6's other fields (career history entries, skill
chips, exclusions) are still visual only — `collectProfileData()` in
`rook-onboarding.html` only maps the fields with a plain text input to
real schema columns for now.

## Running it locally

```bash
npm install
cp .env.example .env    # then fill in real values — see ROOK-Setup-Guide.pdf
```

Also fill in `public/rook-config.js` with your Supabase URL and anon key
(same values, different file — the backend `.env` is never sent to the
browser, but the frontend needs its own copy of the public-safe ones).

```bash
npm start
```

Then open `http://localhost:8080`. To pull real job listings once you've
added at least one employer row in Supabase (see the setup guide, Section 5):

```bash
npm run ingest
```

## Deploying to DigitalOcean App Platform

Full walkthrough with screenshot-level detail is in
`ROOK-Setup-Guide.pdf` — short version, following the same pattern as your
other projects (Node/Express + DigitalOcean App Platform + GitHub web
editor workflow):

1. Push this folder to a new GitHub repo (or paste the files in via the
   GitHub web editor, same as usual).
2. In DigitalOcean App Platform, create a new app from that GitHub repo.
3. App Platform should auto-detect it as a Node app via `package.json`.
   - **Build command:** `npm install`
   - **Run command:** `npm start`
   - **HTTP port:** `8080` (or whatever `$PORT` App Platform assigns —
     `server.js` already reads `process.env.PORT`)
4. **You can deploy with zero environment variables set.** The server
   detects missing Supabase/Stripe config and returns a clean error from
   the affected API routes instead of crashing — every page will load,
   login just won't work yet. Add the real variables from
   `.env.example` whenever you're ready (Section 7 of
   `ROOK-Setup-Guide.pdf`); mark the Supabase service role key and
   Stripe secret key as Encrypted.
5. Fill in `public/rook-config.js` with your real Supabase URL/anon key
   before login will work in the browser (separate from the backend
   `.env` — see the note above in "What's actually wired now").
6. Deploy.

## What's deliberately NOT here yet

- **Match scoring** — `candidate_job_matches` exists as a table but
  nothing populates it; jobs on the dashboard render without a score
  once live data exists, until the matching engine is built
- **Most onboarding fields** — career history entries, skill chips, and
  exclusions are visual only; only Basic Info + a few Preferences fields
  actually save
- Search, job analysis, application package, tracker, saved jobs,
  career intelligence, and settings pages **still show sample data** —
  none of them call the API yet
- No résumé text extraction/parsing — uploaded files are stored but not
  read yet
- No tailored-résumé generation
- No scheduler wired up for `backend/ingest.js` — see the setup guide,
  Section 6, for options
- Only Greenhouse, Lever, and Ashby are supported as job sources; many
  employers (especially ones on Workday) aren't covered yet

All of that is intentional for this stage — see
`ROOK-Technical-Architecture-Spec.docx` for the full Phase 1 / 1.5 / 2
plan for closing these gaps.

## Next step

Fill in `rook-config.js` and `.env` with real values, run through the
testing checklist in `ROOK-Setup-Guide.pdf`, and confirm you can
actually sign up, log in, upload a résumé, and (after running
`npm run ingest` against a real employer) see a live job on the
dashboard. Once that loop works, wiring the remaining pages (search,
job analysis, tracker) follows the same pattern already used in
`rook-dashboard.html`.

