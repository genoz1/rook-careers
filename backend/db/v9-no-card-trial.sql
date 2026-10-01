-- V9-only no-card trial entitlement.
-- Apply before deploying the V9 application changes.

alter table public.candidate_profiles
  add column if not exists subscription_started_at timestamptz,
  add column if not exists trial_source text,
  add column if not exists marketing_consent_at timestamptz;

comment on column public.candidate_profiles.trial_source is
  'Immutable origin of the first free trial (for example v8 or v9).';
comment on column public.candidate_profiles.marketing_consent_at is
  'When the candidate explicitly opted in to trial reminders and match updates; digest_enabled is the current unsubscribe state.';

create or replace function public.activate_v9_trial(
  p_user_id uuid,
  p_marketing_consent boolean default false
)
returns table (
  outcome text,
  subscription_status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_source text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.candidate_profiles%rowtype;
  started timestamptz := clock_timestamp();
begin
  select * into p
  from public.candidate_profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Candidate profile not found';
  end if;

  -- Existing paid members and any account with prior trial/payment history
  -- never receive a new V9 trial. The historical timestamps are intentionally
  -- never cleared, even after logout, cancellation, or expiration.
  if p.subscription_status = 'active' then
    outcome := 'paid';
  elsif p.subscription_status = 'trialing'
     and p.trial_ends_at > started then
    outcome := case when p.trial_source = 'v9' then 'trial_active' else 'existing_access' end;
  elsif p.subscription_started_at is not null then
    outcome := 'paid_lapsed';
  elsif p.trial_started_at is not null
     or p.stripe_customer_id is not null then
    outcome := 'trial_used';
  else
    update public.candidate_profiles
       set subscription_status = 'trialing',
           trial_started_at = started,
           trial_ends_at = started + interval '24 hours',
           trial_source = 'v9',
           digest_enabled = p_marketing_consent,
           marketing_consent_at = case when p_marketing_consent then started else null end,
           updated_at = started
     where user_id = p_user_id;
    outcome := 'started';
  end if;

  return query
  select outcome, c.subscription_status, c.trial_started_at,
         c.trial_ends_at, c.trial_source
  from public.candidate_profiles c
  where c.user_id = p_user_id;
end;
$$;

revoke all on function public.activate_v9_trial(uuid, boolean) from public, anon, authenticated;
grant execute on function public.activate_v9_trial(uuid, boolean) to service_role;
