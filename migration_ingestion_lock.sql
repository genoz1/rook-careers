-- ROOK Careers — nightly ingestion overlap guard, Sept 2026
-- PREPARED BUT NOT EXECUTED. Nothing in this file has been run against the
-- database. backend/ingest.js's tryAcquireIngestLock()/releaseIngestLock()
-- FAIL OPEN if this table doesn't exist yet (they log a warning and let
-- ingestion proceed with no overlap protection), so deploying that code is
-- safe before this migration is applied — it just means overlap protection
-- isn't active yet. Apply this whenever convenient, no coordinated deploy
-- required.
--
-- Why a plain table row instead of pg_advisory_lock(): requests from
-- @supabase/supabase-js go through PostgREST over a pooled Postgres
-- connection, and a session-scoped advisory lock isn't guaranteed to be
-- held by the same connection across the acquire call and the later
-- release call. A conditional UPDATE on an ordinary row has no such
-- assumption — it works the same regardless of connection pooling.
--
-- Design: one fixed row (id=1). Acquiring the lock is a conditional
-- UPDATE that only succeeds if the row is unlocked (locked_at IS NULL) or
-- its lock is stale (older than 35 minutes — a little past DigitalOcean's
-- 30-minute hard timeout for the scheduled job, so a run that really did
-- get killed mid-request doesn't hold the lock forever). See
-- backend/ingest.js's tryAcquireIngestLock()/releaseIngestLock() for the
-- application-side half of this.

create table if not exists ingestion_run_lock (
  id integer primary key,
  locked_at timestamptz,
  locked_by text
);

-- Seed the single row this lock always operates on. ingest.js's UPDATE
-- only ever targets id=1 and does nothing if no row matches, so this seed
-- step is required for the lock to do anything (fail-open covers the
-- "table/row doesn't exist yet" case either way).
insert into ingestion_run_lock (id, locked_at, locked_by)
values (1, null, null)
on conflict (id) do nothing;

-- Row Level Security: this table holds no employer or candidate data,
-- only run-coordination state, and is only ever touched by ingest.js
-- using the service-role key (which bypasses RLS regardless). Enabling
-- RLS with no policies is the safe default for a new table — it blocks
-- any anon/authenticated-role access without needing to reason about
-- what policy would be appropriate for a table that should have none.
alter table ingestion_run_lock enable row level security;
