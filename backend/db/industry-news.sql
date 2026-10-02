-- ROOK Industry News discovery, publishing, and distribution.
-- Additive, fail-closed migration; runtime activity remains controlled by flags.

create table if not exists public.industry_news_sources (
  id text primary key,
  name text not null,
  feed_url text unique,
  canonical_publisher text not null,
  categories jsonb not null default '[]'::jsonb,
  authority_tier smallint not null check (authority_tier between 1 and 3),
  source_kind text not null check (source_kind in ('official','editorial','company','aggregator')),
  status text not null default 'requires_validation'
    check (status in ('active','requires_validation','disabled')),
  requires_feed_validation boolean not null default true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_entry_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.industry_news_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running','complete','partial','failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  metrics jsonb not null default '{}'::jsonb
);

create table if not exists public.industry_news_feed_items (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.industry_news_sources(id),
  discovery_source_ids jsonb not null default '[]'::jsonb,
  feed_buckets jsonb not null default '[]'::jsonb,
  discovery_run_id uuid references public.industry_news_discovery_runs(id),
  guid text not null,
  canonical_url text,
  original_publisher text,
  author_byline text,
  image_url text,
  title text not null,
  rss_summary text,
  published_at timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  retrieval_hash text not null,
  relevance_status text not null default 'review'
    check (relevance_status in ('relevant','review','rejected')),
  relevance_reason text not null,
  categories jsonb not null default '[]'::jsonb,
  event_type text not null default 'unknown',
  entities jsonb not null default '[]'::jsonb,
  products jsonb not null default '[]'::jsonb,
  identifiers jsonb not null default '[]'::jsonb,
  processing_status text not null default 'discovered'
    check (processing_status in ('discovered','candidate','held','rejected','clustered','failed')),
  automation_eligible boolean not null default false,
  eligibility_reason text,
  is_fresh boolean not null default false,
  is_roundup boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists industry_news_feed_items_source_guid
  on public.industry_news_feed_items(source_id,guid);
create unique index if not exists industry_news_feed_items_canonical_url
  on public.industry_news_feed_items(canonical_url) where canonical_url is not null;
create index if not exists industry_news_feed_items_relevance
  on public.industry_news_feed_items(relevance_status,first_seen_at desc);
create index if not exists industry_news_feed_items_event_type
  on public.industry_news_feed_items(event_type,published_at desc);

create table if not exists public.industry_news_events (
  id uuid primary key default gen_random_uuid(),
  cluster_key text not null unique,
  representative_title text not null,
  primary_category text not null,
  categories jsonb not null default '[]'::jsonb,
  event_type text not null default 'unknown',
  entities jsonb not null default '[]'::jsonb,
  products jsonb not null default '[]'::jsonb,
  identifiers jsonb not null default '[]'::jsonb,
  earliest_publication_at timestamptz,
  latest_publication_at timestamptz,
  relevance_status text not null check (relevance_status in ('relevant','review')),
  relevance_reason text not null,
  has_authoritative_evidence boolean not null default false,
  source_count integer not null default 1 check (source_count >= 1),
  processing_status text not null default 'candidate'
    check (processing_status in ('candidate','held','reviewed','rejected','generating','published','failed')),
  lease_owner uuid,
  lease_until timestamptz,
  generation_attempts integer not null default 0,
  last_generation_error text,
  discovery_run_id uuid references public.industry_news_discovery_runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.industry_news_event_sources (
  event_id uuid not null references public.industry_news_events(id) on delete cascade,
  feed_item_id uuid not null references public.industry_news_feed_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(event_id,feed_item_id)
);

create index if not exists industry_news_events_latest
  on public.industry_news_events(latest_publication_at desc);
create index if not exists industry_news_event_sources_item
  on public.industry_news_event_sources(feed_item_id);

create table if not exists public.industry_news_articles (
  slug text primary key check (slug ~ '^[a-z0-9-]{1,110}$'),
  event_id uuid not null unique references public.industry_news_events(id),
  title text not null,
  category text not null,
  event_type text not null,
  description text not null,
  body_html text not null,
  body_hash text not null unique,
  image_alt text not null,
  sources jsonb not null check (jsonb_typeof(sources) = 'array'),
  social_copy jsonb not null check (jsonb_typeof(social_copy) = 'object'),
  word_count integer not null check (word_count between 250 and 1000),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  public_verified_at timestamptz
);

create table if not exists public.industry_news_distribution (
  article_slug text not null references public.industry_news_articles(slug) on delete cascade,
  channel text not null check (channel in ('facebook','instagram')),
  state text not null default 'queued' check (state in ('queued','sending','sent','uncertain')),
  receipt jsonb,
  updated_at timestamptz not null default now(),
  primary key(article_slug,channel)
);

create or replace function public.claim_industry_news_event(p_owner uuid, p_freshness_hours integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare chosen uuid;
begin
  perform pg_advisory_xact_lock(hashtext('rook-industry-news-publication'));
  update industry_news_events set processing_status='candidate',lease_owner=null,lease_until=null
    where processing_status='generating' and lease_until < now() and generation_attempts < 3;
  select e.id into chosen from industry_news_events e
    where e.processing_status='candidate' and e.relevance_status='relevant' and e.event_type<>'unknown'
      and e.latest_publication_at >= now() - make_interval(hours => greatest(6,least(p_freshness_hours,168)))
      and not exists(select 1 from industry_news_articles a where a.event_id=e.id)
    order by e.source_count desc,e.latest_publication_at desc for update skip locked limit 1;
  if chosen is not null then update industry_news_events set processing_status='generating',lease_owner=p_owner,lease_until=now()+interval '10 minutes' where id=chosen; end if;
  return chosen;
end $$;

create or replace function public.publish_industry_news_article(p_event uuid,p_owner uuid,p_article jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare saved industry_news_articles;
begin
  if not exists(select 1 from industry_news_events where id=p_event and processing_status='generating' and lease_owner=p_owner and lease_until>now()) then raise exception 'generation lease lost'; end if;
  insert into industry_news_articles(slug,event_id,title,category,event_type,description,body_html,body_hash,image_alt,sources,social_copy,word_count)
  values(p_article->>'slug',p_event,p_article->>'title',p_article->>'category',p_article->>'event_type',p_article->>'description',p_article->>'body_html',p_article->>'body_hash',p_article->>'image_alt',p_article->'sources',p_article->'social_copy',(p_article->>'word_count')::integer)
  on conflict(event_id) do update set updated_at=industry_news_articles.updated_at returning * into saved;
  update industry_news_events set processing_status='published',lease_owner=null,lease_until=null where id=p_event;
  insert into industry_news_distribution(article_slug,channel) values(saved.slug,'facebook'),(saved.slug,'instagram') on conflict do nothing;
  return to_jsonb(saved);
end $$;

create or replace function public.fail_industry_news_generation(p_event uuid,p_owner uuid,p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update industry_news_events set generation_attempts=generation_attempts+1,last_generation_error=left(p_error,500),lease_owner=null,lease_until=null,
    processing_status=case when generation_attempts+1>=3 then 'failed' else 'candidate' end
    where id=p_event and lease_owner=p_owner;
end $$;

alter table public.industry_news_sources enable row level security;
alter table public.industry_news_discovery_runs enable row level security;
alter table public.industry_news_feed_items enable row level security;
alter table public.industry_news_events enable row level security;
alter table public.industry_news_event_sources enable row level security;
alter table public.industry_news_articles enable row level security;
alter table public.industry_news_distribution enable row level security;

revoke all on public.industry_news_sources, public.industry_news_discovery_runs,
  public.industry_news_feed_items, public.industry_news_events,
  public.industry_news_event_sources from anon, authenticated;
revoke all on public.industry_news_articles, public.industry_news_distribution from anon, authenticated;
grant all on public.industry_news_sources, public.industry_news_discovery_runs,
  public.industry_news_feed_items, public.industry_news_events,
  public.industry_news_event_sources to service_role;
grant all on public.industry_news_articles, public.industry_news_distribution to service_role;
revoke all on function public.claim_industry_news_event(uuid,integer), public.publish_industry_news_article(uuid,uuid,jsonb), public.fail_industry_news_generation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_industry_news_event(uuid,integer), public.publish_industry_news_article(uuid,uuid,jsonb), public.fail_industry_news_generation(uuid,uuid,text) to service_role;
