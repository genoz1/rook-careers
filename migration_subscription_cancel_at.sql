-- ROOK — add subscription_cancel_at column
-- Needed for the Settings page to show "Cancels on [date]" instead of
-- a flat "Active" for a subscriber who's already cancelled via
-- Stripe's portal but keeps access until the paid period ends.

alter table candidate_profiles add column if not exists subscription_cancel_at timestamptz;
