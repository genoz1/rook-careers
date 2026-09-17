-- Apply before deploying readers/writers that select this column.
-- No existing job coordinates or industry fields are changed here.
alter table public.jobs add column if not exists location_evidence jsonb;
comment on column public.jobs.location_evidence is
  'Source country and geocode validation provenance; source evidence overrides inferred U.S. coordinates.';
