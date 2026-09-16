-- Apply before deploying a worker that schedules the new midday slot.
alter table public.social_post_history
  drop constraint if exists social_post_history_slot_check;
alter table public.social_post_history
  add constraint social_post_history_slot_check
  check (slot in ('am', 'mid', 'pm'));
