-- Additive receipt fields for first-paid LinkedIn delivery. Apply before deployment.
-- Existing rows remain unmodified and are not backfilled to LinkedIn.
begin;
alter table public.ad_conversion_events add column if not exists linkedin_invoice_id text;
alter table public.ad_conversion_events add column if not exists linkedin_email_sha256 text;
alter table public.ad_conversion_events add column if not exists linkedin_sent_at timestamptz;
commit;
