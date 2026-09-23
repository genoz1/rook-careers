-- Optional alerts only: no auth accounts, entitlement changes or client table access.
begin;
create table if not exists public.pretrial_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(trim(email))),
  profile jsonb not null,
  consent_at timestamptz not null default now(),
  consent_source text not null check (consent_source in ('onboarding','exit')),
  consent_version text not null default 'job_matches_v1',
  digest_enabled boolean not null default true,
  unsubscribe_token text not null unique,
  unsubscribed_at timestamptz
);
create table if not exists public.pretrial_alert_jobs (
  lead_id uuid not null references public.pretrial_leads(id),
  job_id uuid not null,
  reserved_at timestamptz not null default now(),
  primary key (lead_id,job_id)
);
alter table public.pretrial_leads enable row level security;
alter table public.pretrial_alert_jobs enable row level security;
revoke all on public.pretrial_leads, public.pretrial_alert_jobs from anon, authenticated;
grant all on public.pretrial_leads, public.pretrial_alert_jobs to service_role;
alter table public.onboarding_v7_sessions add column if not exists alert_requested boolean not null default false;

create or replace function public.capture_pretrial_alert(p_hash text,p_email text,p_source text,p_unsubscribe text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.onboarding_v7_sessions;
begin
  select * into s from public.onboarding_v7_sessions where token_hash=p_hash and expires_at>now() for update;
  if not found or s.user_id is not null then raise exception 'Invalid anonymous session'; end if;
  if s.alert_requested then return; end if;
  -- Email possession is unverified. Never overwrite another lead's search,
  -- reactivate an opt-out, or alter/create an existing auth account.
  if not exists (select 1 from auth.users where lower(email)=p_email)
     and not exists (select 1 from public.candidate_profiles where lower(email)=p_email) then
    insert into public.pretrial_leads(email,profile,consent_source,unsubscribe_token)
    values(p_email,s.profile,p_source,p_unsubscribe) on conflict(email) do nothing;
  end if;
  update public.onboarding_v7_sessions set alert_requested=true where token_hash=p_hash;
end $$;
create or replace function public.pretrial_alert_eligible(p_id uuid)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.pretrial_leads l where l.id=p_id and l.digest_enabled
    and not exists(select 1 from auth.users u where lower(u.email)=l.email)
    and not exists(select 1 from public.candidate_profiles p where lower(p.email)=l.email));
$$;
revoke all on function public.capture_pretrial_alert(text,text,text,text),public.pretrial_alert_eligible(uuid) from public,anon,authenticated;
grant execute on function public.capture_pretrial_alert(text,text,text,text),public.pretrial_alert_eligible(uuid) to service_role;
commit;
