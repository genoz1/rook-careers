-- ROOK — add the composite index precompute.js's own comments called
-- for but that was never actually created. The paginated job-loading
-- query filters on (status, moderation_status) and orders by id for
-- deterministic .range()-based pagination - with only a single-column
-- index on status, Postgres has to scan and discard an increasing
-- number of rows on each successive page, which gets slower as the
-- jobs table grows and is the direct cause of the "canceling
-- statement due to statement timeout" error just hit. This lets
-- Postgres seek straight to the right rows instead.

create index if not exists idx_jobs_status_moderation_id on jobs(status, moderation_status, id);
