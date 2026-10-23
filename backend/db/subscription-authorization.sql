-- Optional relational store for subscription authorization evidence.
-- Production currently persists evidence in the private Supabase Storage bucket
-- `subscription-authorizations` (service-role only) so checkout can ship without
-- blocking on DDL. Apply this SQL only for an intentional table cutover.
-- Do not backfill invented historical consent.

create table if not exists public.subscription_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null check (plan_id in ('two_day', 'monthly', 'three_month')),
  kind text not null check (kind in ('one_time', 'subscription')),
  consent_text text not null,
  terms_version text not null,
  checkout_version text not null,
  initial_price_cents integer not null check (initial_price_cents > 0),
  recurring_price_cents integer null check (recurring_price_cents is null or recurring_price_cents > 0),
  billing_interval text null,
  cancellation_summary text not null,
  consented_at timestamptz not null default now(),
  status text not null default 'consented'
    check (status in ('consented', 'completed', 'expired')),
  ip_hash text null,
  user_agent_hash text null,
  stripe_customer_id text null,
  stripe_subscription_id text null,
  stripe_payment_intent_id text null,
  purchase_reference text null,
  completed_at timestamptz null,
  confirmation_email_sent_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_subscription_authorizations_user_consented
  on public.subscription_authorizations (user_id, consented_at desc);

create index if not exists idx_subscription_authorizations_open
  on public.subscription_authorizations (user_id, plan_id, status, consented_at desc)
  where status = 'consented';

alter table public.subscription_authorizations enable row level security;

-- Customers never read or write these rows directly from the client.
revoke all on public.subscription_authorizations from anon, authenticated;
grant all on public.subscription_authorizations to service_role;

comment on table public.subscription_authorizations is
  'Immutable billing authorization evidence recorded before payment. Never invent historical consent.';
