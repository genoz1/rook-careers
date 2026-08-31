-- ROOK — add missing index on job coordinates
-- Needed for the new location-search feature's bounding-box query to
-- actually be fast rather than a full table scan. Safe to run anytime.

create index if not exists idx_jobs_coords on jobs(job_lat, job_lng);
