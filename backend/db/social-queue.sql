-- Apply once before enabling the revised scheduled-dispatch command.
-- Service-role only; no public policies or changes to existing job tables.
create table if not exists public.social_queue_sends (
  run_key text not null,
  channel_id text not null,
  state text not null check (state in ('sending', 'scheduled', 'rejected')),
  payload jsonb not null,
  post jsonb,
  primary key (run_key, channel_id)
);
alter table public.social_queue_sends enable row level security;
revoke all on public.social_queue_sends from anon, authenticated;
grant all on public.social_queue_sends to service_role;

create table if not exists public.social_queue_lock (
  id integer primary key check (id = 1), owner uuid, expires_at timestamptz
);
alter table public.social_queue_lock enable row level security;
revoke all on public.social_queue_lock from anon, authenticated;
grant all on public.social_queue_lock to service_role;
insert into public.social_queue_lock(id) values (1) on conflict do nothing;

create or replace function public.claim_social_queue(lock_owner uuid)
returns boolean language sql security invoker set search_path = public as $$
  with claimed as (
    update social_queue_lock set owner = lock_owner, expires_at = now() + interval '20 minutes'
    where id = 1 and (expires_at is null or expires_at < now() or owner = lock_owner)
    returning id
  ) select exists(select 1 from claimed);
$$;
revoke all on function public.claim_social_queue(uuid) from public, anon, authenticated;
grant execute on function public.claim_social_queue(uuid) to service_role;
