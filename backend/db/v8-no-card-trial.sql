-- V8 no-card trial entitlement. Apply before deploying the V8 application changes.
-- The shared candidate profile fields were introduced by v9-no-card-trial.sql;
-- using them here makes first-trial history account-wide across V8 and V9.

create or replace function public.activate_v8_trial(p_user_id uuid)
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

  if p.subscription_status = 'active' then
    outcome := 'paid';
  elsif p.subscription_status = 'trialing'
     and p.trial_ends_at > started then
    outcome := case when p.trial_source = 'v8' then 'trial_active' else 'existing_access' end;
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
           trial_source = 'v8',
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

revoke all on function public.activate_v8_trial(uuid) from public, anon, authenticated;
grant execute on function public.activate_v8_trial(uuid) to service_role;
