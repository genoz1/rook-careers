-- ROOK Ad Manager — database migration
-- Run in Supabase SQL Editor. Safe to re-run (IF NOT EXISTS everywhere).
-- All timestamps are UTC. All monetary values are USD cents unless noted.

-- ── 1. ad_platform_accounts ───────────────────────────────────────────────
-- One row per ad account on each platform. Credentials live in env vars;
-- this table stores only the non-secret identifiers needed to query APIs.
create table if not exists ad_platform_accounts (
  id              uuid primary key default gen_random_uuid(),
  platform        text not null check (platform in ('google','meta','reddit')),
  account_id      text not null,           -- platform-native account/customer ID
  account_name    text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (platform, account_id)
);

-- ── 2. ad_campaign_controls ───────────────────────────────────────────────
-- One row per managed campaign. Every automated action requires a row here
-- with approved_for_automation = true AND desired_state = 'active'.
create table if not exists ad_campaign_controls (
  id                          uuid primary key default gen_random_uuid(),
  platform                    text not null check (platform in ('google','meta','reddit')),
  external_campaign_id        text not null,
  campaign_name               text,
  account_id                  uuid references ad_platform_accounts(id),
  desired_state               text not null default 'paused'
                                check (desired_state in ('active','paused','archived')),
  approved_for_automation     boolean not null default false,
  optimization_event          text not null default 'onboarding_completed'
                                check (optimization_event in (
                                  'landing_page_view','onboarding_started',
                                  'onboarding_completed','trial_started',
                                  'paid_subscription_started')),
  destination_url             text not null default
                                'https://rookcareers.com/rook-onboarding-v4.html',
  min_daily_budget_cents      integer not null default 100,   -- $1.00
  max_daily_budget_cents      integer not null default 2500,  -- $25.00
  notes                       text,
  last_action                 text,
  last_action_at              timestamptz,
  last_verified_delivery_at   timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (platform, external_campaign_id)
);

-- ── 3. ad_performance_snapshots ───────────────────────────────────────────
-- Immutable time-series rows written every health-check cycle.
-- Never updated — audit log by design.
create table if not exists ad_performance_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  campaign_control_id     uuid references ad_campaign_controls(id),
  platform                text not null,
  external_campaign_id    text not null,
  snapshot_date           date not null,
  snapshot_hour           integer,             -- 0-23 UTC hour of this snapshot
  spend_cents             integer default 0,   -- reported spend in USD cents
  impressions             bigint  default 0,
  clicks                  integer default 0,
  landing_page_views      integer default 0,
  conversions_landing     integer default 0,   -- platform-reported landing events
  conversions_onboarding  integer default 0,   -- platform-reported onboarding events
  conversions_trial       integer default 0,   -- platform-reported trial events
  effective_status        text,                -- platform delivery status string
  raw_api_response        jsonb,               -- full platform API response (no secrets)
  fetched_at              timestamptz not null default now()
);
create index if not exists idx_adsnap_campaign_date
  on ad_performance_snapshots(campaign_control_id, snapshot_date desc);
create index if not exists idx_adsnap_date
  on ad_performance_snapshots(snapshot_date desc);

-- ── 4. ad_manager_actions ─────────────────────────────────────────────────
-- Every decision the manager makes — including dry-run — is logged here.
create table if not exists ad_manager_actions (
  id                      uuid primary key default gen_random_uuid(),
  mode                    text not null check (mode in ('dry-run','write')),
  platform                text,
  external_campaign_id    text,
  campaign_control_id     uuid references ad_campaign_controls(id),
  action_type             text not null,   -- e.g. 'pause_campaign','adjust_budget','skip_no_approval'
  reason                  text not null,
  proposed_value          jsonb,           -- what would change / did change
  previous_value          jsonb,
  executed                boolean not null default false,
  api_response            jsonb,           -- platform response (secrets stripped)
  error                   text,
  created_at              timestamptz not null default now()
);
create index if not exists idx_adaction_created
  on ad_manager_actions(created_at desc);
create index if not exists idx_adaction_campaign
  on ad_manager_actions(campaign_control_id, created_at desc);

-- ── 5. ad_manager_alerts ──────────────────────────────────────────────────
-- Alerts raised during health checks. One row per alert event.
create table if not exists ad_manager_alerts (
  id                      uuid primary key default gen_random_uuid(),
  severity                text not null check (severity in ('critical','warning','info')),
  alert_type              text not null,   -- e.g. 'campaign_stopped','billing_block','wrong_url'
  platform                text,
  external_campaign_id    text,
  campaign_control_id     uuid references ad_campaign_controls(id),
  message                 text not null,
  details                 jsonb,
  email_sent              boolean not null default false,
  resolved                boolean not null default false,
  resolved_at             timestamptz,
  created_at              timestamptz not null default now()
);
create index if not exists idx_adalert_created
  on ad_manager_alerts(created_at desc);
create index if not exists idx_adalert_unresolved
  on ad_manager_alerts(resolved, severity, created_at desc)
  where resolved = false;

-- ── 6. ad_conversion_events ───────────────────────────────────────────────
-- First-party server-side conversion events. Deduplicated by event_key.
create table if not exists ad_conversion_events (
  id                  uuid primary key default gen_random_uuid(),
  event_key           text not null unique,  -- dedup key: user_id + event_type + date
  event_type          text not null check (event_type in (
                        'landing_page_view','onboarding_started',
                        'onboarding_completed','trial_started',
                        'paid_subscription_started')),
  user_id             uuid,                  -- null for anonymous events
  anonymous_id        text,                  -- browser fingerprint / session ID
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  utm_term            text,
  utm_content         text,
  gclid               text,                  -- Google click ID
  fbclid              text,                  -- Meta click ID
  reddit_click_id     text,
  platform_inferred   text,                  -- 'google','meta','reddit','organic'
  ip_hash             text,                  -- hashed, not raw IP
  user_agent_hash     text,
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null  default now()
);
create index if not exists idx_adconv_event_type_date
  on ad_conversion_events(event_type, occurred_at desc);
create index if not exists idx_adconv_user
  on ad_conversion_events(user_id, occurred_at desc)
  where user_id is not null;
create index if not exists idx_adconv_source_date
  on ad_conversion_events(platform_inferred, occurred_at desc);
