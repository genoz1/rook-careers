-- Additive V7-only storage. Existing profiles, jobs, Stripe and V6 are untouched.
create table if not exists public.onboarding_v7_sessions (
  token_hash text primary key,
  user_id uuid references auth.users(id),
  profile jsonb not null,
  jobs jsonb not null,
  resume_path text,
  resume_name text,
  resume_type text,
  transferred_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.onboarding_v7_sessions enable row level security;
revoke all on public.onboarding_v7_sessions from anon, authenticated;
grant all on public.onboarding_v7_sessions to service_role;
create index if not exists onboarding_v7_expiry on public.onboarding_v7_sessions(expires_at);
insert into storage.buckets (id,name,public,file_size_limit)
values ('onboarding-v7-private','onboarding-v7-private',false,10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;
-- No client storage policies: only the server service role can access this bucket.

-- Existing broad Storage policies must not accidentally include this bucket.
drop policy if exists v7_private_storage_boundary on storage.objects;
create policy v7_private_storage_boundary on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'onboarding-v7-private')
  with check (bucket_id <> 'onboarding-v7-private');
