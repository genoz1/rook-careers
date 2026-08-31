-- ROOK — speed fix for slow job loading
-- Adds the one index the dashboard/search query actually needs (filter
-- by candidate, sort by score, together) - the two existing indexes
-- only cover each half separately. Safe to run anytime, no downtime.

create index if not exists idx_matches_candidate_score on candidate_job_matches(candidate_id, overall_score desc);
