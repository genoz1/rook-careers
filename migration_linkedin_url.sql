-- ROOK — add linkedin_url column
-- Needed for the Settings page's LinkedIn URL field, which was
-- previously disabled with no backing column at all.

alter table candidate_profiles add column if not exists linkedin_url text;
