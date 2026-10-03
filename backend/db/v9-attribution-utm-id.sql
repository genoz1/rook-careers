-- Apply before deploying the attribution code; no data or billing changes.
begin;
alter table public.candidate_profiles add column if not exists utm_id text;
alter table public.ad_conversion_events add column if not exists utm_id text;
commit;
