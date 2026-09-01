-- ROOK — backfill HTML entity cleanup for existing jobs
-- Fixes literal &nbsp; and encoded apostrophes/quotes already stored in
-- description_text for jobs ingested before the adapter fix. The code
-- fix (backend/adapters/*.js) only prevents this in newly-ingested
-- jobs going forward - this cleans up what's already in the database.
-- Safe to run anytime; only touches description_text, no other columns.

update jobs
set description_text = trim(regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(description_text, '&nbsp;', ' ', 'gi'),
                '&#39;|&apos;|&rsquo;|&lsquo;', '''', 'gi'),
              '&quot;|&rdquo;|&ldquo;', '"', 'gi'),
            '&ndash;', '-', 'gi'),
          '&mdash;', '—', 'gi'),
        '&hellip;', '...', 'gi'),
      '&lt;', '<', 'gi'),
    '&gt;', '>', 'gi'),
  '&amp;', '&', 'gi'),
'\s+', ' ', 'g'))
where description_text ~* '&nbsp;|&#39;|&apos;|&rsquo;|&lsquo;|&quot;|&rdquo;|&ldquo;|&ndash;|&mdash;|&hellip;|&amp;|&lt;|&gt;';
