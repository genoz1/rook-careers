-- Remove Oak Street Health — its identifier points at CVS Health's
-- entire corporate Workday tenant (18,700+ postings: pharmacy techs,
-- store managers, cashiers, etc.), not a scoped Oak Street Health board.
-- No per-job brand-extraction was built for this tenant the way it was
-- for Danaher/J&J/Envista/Owens & Minor, so every one of those jobs
-- would be mislabeled as "Oak Street Health." CVS Health itself isn't
-- relevant to this platform's niche, so removing rather than fixing
-- attribution.

-- Clean up any jobs already saved under this employer first (must run
-- before deleting the employer row, since this lookup depends on it
-- still existing).
delete from jobs where employer_id in (
  select id from employers where company_slug = 'oak-street-health'
);

delete from employers where company_slug = 'oak-street-health';
