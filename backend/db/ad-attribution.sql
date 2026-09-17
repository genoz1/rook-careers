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

alter table public.ad_conversion_events enable row level security;
revoke all on public.ad_conversion_events from anon, authenticated;
