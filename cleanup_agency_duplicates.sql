-- ROOK — clean up existing agency-aggregated duplicate postings
-- Closes (does not delete) all but the oldest copy of each
-- company+normalized-title duplicate group among agency_aggregated
-- jobs, so candidates stop seeing the same listing repeated several
-- times. Safe to run anytime; closed jobs stay out of candidate-facing
-- results but aren't permanently deleted (archiveOldJobs.js handles
-- that separately after 90 days closed).

with normalized as (
  select
    id,
    company_name,
    lower(regexp_replace(regexp_replace(title_original, '[-–—]\s*\d+k?\s*$', '', 'i'), '[^a-zA-Z0-9]+', ' ', 'g')) as norm_title,
    first_seen_at,
    row_number() over (
      partition by company_name, lower(regexp_replace(regexp_replace(title_original, '[-–—]\s*\d+k?\s*$', '', 'i'), '[^a-zA-Z0-9]+', ' ', 'g'))
      order by first_seen_at asc
    ) as rn
  from jobs
  where source_type = 'agency_aggregated' and status = 'active'
)
update jobs
set status = 'closed'
where id in (select id from normalized where rn > 1);
