-- All inventory writers invalidate both production instances transactionally.
-- Apply before deploying the index; absent migration uses authoritative reads.
begin;
create table if not exists public.v8_matching_revision (
  id integer primary key check (id=1),
  revision bigint not null default 1
);
insert into public.v8_matching_revision(id) values(1) on conflict do nothing;
alter table public.v8_matching_revision enable row level security;
revoke all on public.v8_matching_revision from public, anon, authenticated;
grant select on public.v8_matching_revision to service_role;
create or replace function public.invalidate_v8_matching_index() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.v8_matching_revision set revision=revision+1 where id=1;
  return null;
end;
$$;
revoke all on function public.invalidate_v8_matching_index() from public,anon,authenticated;
drop trigger if exists v8_matching_inventory_changed on public.jobs;
create trigger v8_matching_inventory_changed after insert or update or delete or truncate
on public.jobs for each statement execute function public.invalidate_v8_matching_index();
-- One required round trip: validate snapshot, persist capability/profile,
-- retrieve only the two revealed jobs. No full result snapshot is stored.
create or replace function public.create_v8_preview_session(
  p_token_hash text,p_profile jsonb,p_expires_at timestamptz,p_revision bigint,p_job_ids uuid[]
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare current_revision bigint; details jsonb; started timestamptz;
begin
  select revision into current_revision from public.v8_matching_revision where id=1 for share;
  if current_revision is distinct from p_revision then
    return jsonb_build_object('accepted',false);
  end if;
  if cardinality(p_job_ids)>2 or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_profile->>'onboarding_version' is distinct from 'v8' then
    raise exception 'Invalid preview session';
  end if;
  started:=clock_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'company_name',company_name,'city',city,
    'application_url',application_url,'source_url',source_url)),'[]'::jsonb)
    into details from public.jobs where id=any(p_job_ids) and status='active' and moderation_status='approved';
  if jsonb_array_length(details)<>cardinality(p_job_ids) then return jsonb_build_object('accepted',false); end if;
  insert into public.onboarding_v7_sessions(token_hash,profile,jobs,expires_at)
    values(p_token_hash,p_profile,'[]'::jsonb,p_expires_at);
  return jsonb_build_object('accepted',true,'jobs',details,'details_ms',extract(epoch from clock_timestamp()-started)*1000);
end;
$$;
revoke all on function public.create_v8_preview_session(text,jsonb,timestamptz,bigint,uuid[]) from public,anon,authenticated;
grant execute on function public.create_v8_preview_session(text,jsonb,timestamptz,bigint,uuid[]) to service_role;
commit;
