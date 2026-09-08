-- Migration: add territory_size_preferences to candidate_profiles
-- Run after: backend/db/add-home-location-label.sql
-- Run before deploying application code that writes this column.
--
-- Why a new column instead of changing territory_size_preference text:
--   territory_size_preference (text) stores a single value for existing users.
--   Changing it to text[] would require migrating all existing rows and updating
--   all downstream reads. A parallel column lets old code continue reading the
--   single-value field while new code writes and reads the array field.
--   Existing users retain territory_size_preference as their "first selected" value.
--
-- Backward compatibility:
--   On save, the application writes BOTH columns:
--     territory_size_preferences = ['local','remote']   (new array)
--     territory_size_preference  = 'local'              (first value, backward compat)
--   Existing rows where territory_size_preferences IS NULL remain valid;
--   settings and onboarding fall back to reading territory_size_preference.

ALTER TABLE candidate_profiles
  ADD COLUMN IF NOT EXISTS territory_size_preferences text[];
