-- Migration: add onboarding_version to candidate_profiles
-- Run after: add-territory-preferences.sql
-- Run before deploying application code that writes this column.
--
-- Purpose: distinguishes users who completed the new v2 onboarding flow
-- (which requires résumé + successful analysis before dashboard access)
-- from users who completed the old flow where résumé was optional.
--
-- Null  = legacy user (pre-deployment); routed to dashboard without
--         résumé requirement, to avoid blocking existing customers.
-- 2     = completed the new v2 flow; résumé + analysis required before
--         first dashboard access.
--
-- Backward compatibility: existing rows remain NULL. The application
-- reads this column at startup routing time and applies the new
-- requirement only to rows where onboarding_version = 2.

ALTER TABLE candidate_profiles
  ADD COLUMN IF NOT EXISTS onboarding_version integer;
