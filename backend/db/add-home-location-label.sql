-- Migration: add home_location_label to candidate_profiles
-- Run once against the production database.
-- This stores the user-facing label for the primary job-search location
-- (e.g. "Boise, ID" or "34484 — Oxford, FL") so it can be displayed on
-- the dashboard without recomputing from home_city + home_state each time.
-- Existing rows: NULL (will be populated on next profile save or location change).

ALTER TABLE candidate_profiles
  ADD COLUMN IF NOT EXISTS home_location_label text;
