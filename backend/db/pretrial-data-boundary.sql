-- Deploy the server's service-role job reads BEFORE running this migration.
-- No source records are changed. Restrictive policies also cover future
-- permissive policies: job data must pass through the authorization-aware API.
BEGIN;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_api_only ON public.jobs;
CREATE POLICY jobs_api_only ON public.jobs AS RESTRICTIVE FOR SELECT TO anon, authenticated USING (false);
-- Match reasons/categories contain source text, too. Browser clients use /api.
ALTER TABLE public.candidate_job_matches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matches_api_only ON public.candidate_job_matches;
CREATE POLICY matches_api_only ON public.candidate_job_matches AS RESTRICTIVE FOR SELECT TO anon, authenticated USING (false);
-- Profiles must also be written through the existing server API, which has a
-- field allowlist. Otherwise an owner could self-assign subscription_status.
DROP POLICY IF EXISTS profile_insert_api_only ON public.candidate_profiles;
CREATE POLICY profile_insert_api_only ON public.candidate_profiles AS RESTRICTIVE FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS profile_update_api_only ON public.candidate_profiles;
CREATE POLICY profile_update_api_only ON public.candidate_profiles AS RESTRICTIVE FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
COMMIT;
