-- Apply before enabling custom_html employers. Does not enroll sources or
-- change existing listings. Preserve all currently allowed ATS types.
begin;
alter table public.jobs add column if not exists extraction_evidence jsonb;
comment on column public.jobs.extraction_evidence is
  'Deterministic extraction tier/confidence, source posting status, territory groups, application destinations and content hashes. Independent of source_verified.';
do $$
declare old_check text;
begin
  select pg_get_constraintdef(oid) into old_check from pg_constraint
  where conrelid = 'public.employers'::regclass and conname = 'employers_ats_type_check';
  if old_check is null then
    raise exception 'Expected employers_ats_type_check; inspect live schema before applying';
  end if;
  if position('custom_html' in old_check) = 0 then
    alter table public.employers drop constraint employers_ats_type_check;
    execute 'alter table public.employers add constraint employers_ats_type_check check ((' ||
      substring(old_check from 7) || ') or ats_type = ''custom_html'')';
  end if;
end $$;
commit;
